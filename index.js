import 'dotenv/config'
import { MongoClient, ObjectId } from "mongodb";

import express from 'express';
import cors from 'cors';
import Stripe from "stripe";

import verifyToken from "./middlewares/verifyToken.js";
import verifyAdmin from "./middlewares/verifyAdmin.js";
import verifyCustomer from './middlewares/verifyCustomer.js';
import verifyActiveUser from "./middlewares/verifyActiveUser.js";

const app = express();


const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Stripe Webhook 
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error("Webhook signature verification failed:", error.message);

      return res.status(400).send({
        success: false,
        message: "Invalid webhook signature.",
      });
    }

    // Webhook event processing will go here.
    res.status(200).send({ received: true });
  }
);

// middleware!
app.use(cors({
  origin: "http://localhost:3000",
  credentials: true,
}));


app.use(express.json())

const client = new MongoClient(process.env.MONGO_DB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const mongoClient = await connectToMongoDB()
const db = mongoClient.db("salonBook")

app.locals.db = db;
// Database collections --
const servicesCollection = db.collection("services")
const appointmentsCollection = db.collection("appointments");
const transactionsCollection = db.collection("transactions");

await transactionsCollection.createIndex(
  { stripeSessionId: 1 },
  { unique: true }
);

const processSuccessfulPayment = async (session) => {
  // 1. Verify Stripe payment status
  if (
    session.status !== "complete" ||
    session.payment_status !== "paid"
  ) {
    throw new Error("Payment is not completed.");
  }

  // 2. Validate session metadata
  const { appointmentId, customerId } = session.metadata || {};

  if (
    !appointmentId ||
    !customerId ||
    !ObjectId.isValid(appointmentId)
  ) {
    throw new Error("Invalid payment metadata.");
  }

  // 3. Validate Stripe session information
  if (
    session.mode !== "payment" ||
    session.currency !== "bdt" ||
    session.client_reference_id !== appointmentId
  ) {
    throw new Error("Invalid Stripe session details.");
  }

  // 4. Start MongoDB transaction
  const mongoSession = client.startSession();

  try {
    const result = await mongoSession.withTransaction(async () => {

      // Check whether this Stripe session was already processed
      const existingTransaction = await transactionsCollection.findOne(
        { stripeSessionId: session.id },
        { session: mongoSession }
      );

      if (existingTransaction) {
        return {
          success: true,
          alreadyProcessed: true,
          message: "Payment has already been processed.",
        };
      }

      // 5. Find appointment belonging to the customer
      const appointment = await appointmentsCollection.findOne(
        {
          _id: new ObjectId(appointmentId),
          customerId,
        },
        { session: mongoSession }
      );

      if (!appointment) {
        throw new Error("Appointment not found.");
      }

      // 6. Only confirmed appointments can be paid
      if (appointment.status !== "confirmed") {
        throw new Error("Only confirmed appointments can be paid.");
      }

      // 7. Prevent duplicate payment for the same appointment
      if (appointment.paymentStatus !== "unpaid") {
        throw new Error("This appointment has already been paid.");
      }

      // 8. Verify actual appointment price
      const amount = Number(appointment.servicePrice);

      if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        session.amount_total !== Math.round(amount * 100)
      ) {
        throw new Error("Payment amount does not match.");
      }

      // Check whether another Stripe session already paid this appointment
      const existingAppointmentTransaction =
        await transactionsCollection.findOne(
          { appointmentId: appointment._id },
          { session: mongoSession }
        );

      if (existingAppointmentTransaction) {
        throw new Error("A transaction already exists for this appointment.");
      }

      // 9. Update appointment payment status
      const updateResult = await appointmentsCollection.updateOne(
        {
          _id: appointment._id,
          customerId,
          status: "confirmed",
          paymentStatus: "unpaid",
        },
        {
          $set: {
            paymentStatus: "paid",
            paidAt: new Date(),
          },
        },
        { session: mongoSession }
      );

      if (updateResult.modifiedCount !== 1) {
        throw new Error("Appointment payment status could not be updated.");
      }

      // 10. Save transaction
      const transactionData = {
        appointmentId: appointment._id,
        customerId,
        amount,
        currency: session.currency,
        stripeSessionId: session.id,
        status: "paid",
        createdAt: new Date(),
      };

      await transactionsCollection.insertOne(
        transactionData,
        { session: mongoSession }
      );

      return {
        success: true,
        alreadyProcessed: false,
        message: "Payment processed successfully.",
      };
    });

    return result;

  } finally {
    await mongoSession.endSession();
  }
};

app.post("/payment/checkout-verify", verifyToken, verifyActiveUser, verifyCustomer, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const customerId = req.user.id;

    if (!sessionId) {
      return res.status(400).send({
        success: false,
        message: "Stripe session ID is required.",
      });
    }

    // Retrieve session directly from Stripe
    const stripeSession =
      await stripe.checkout.sessions.retrieve(sessionId);

    // Verify session ownership
    if (stripeSession.metadata?.customerId !== customerId) {
      return res.status(403).send({
        success: false,
        message: "You are not authorized to verify this payment.",
      });
    }

    // Process verified payment
    const result = await processSuccessfulPayment(stripeSession);

    return res.status(200).send(result);

  } catch (error) {
    console.error("Checkout Verification Error:", error);

    return res.status(400).send({
      success: false,
      message: error.message || "Payment verification failed.",
    });
  }
}
);


// http://localhost:5000/services
app.get('/services', async (req, res) => {
  try {
    const { search, category, sort } = req.query;

    // Build filter
    const filter = {
      status: "active",
    };

    // Search by service name
    if (search) {
      filter.serviceName = {
        $regex: search,
        $options: "i",
      };
    }

    // Category filtering
    if (category) {
      filter.category = category;
    }

    // Price sorting
    let sortOption = { createdAt: -1 };

    if (sort === "price-asc") {
      sortOption = { price: 1 };
    } else if (sort === "price-desc") {
      sortOption = { price: -1 };
    }

    const result = await servicesCollection
      .find(filter)
      .sort(sortOption)
      .toArray();

    res.status(200).send(result);

  } catch (error) {
    console.error("Failed to fetch services:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch services",
    });
  }
});

// http://localhost:5000/services
app.post('/services', verifyToken, verifyActiveUser, verifyAdmin, async (req, res) => {
  try {
    const {
      serviceName,
      category,
      description,
      price,
      duration,
      image
    } = req.body;

    if (
      !serviceName?.trim() ||
      !category ||
      !description?.trim() ||
      !image ||
      price === undefined ||
      duration === undefined
    ) {
      return res.status(400).send({
        message: 'All fields are required'
      });
    }

    const categories = [
      "Haircut & Styling",
      "Hair Coloring",
      "Hair Treatment",
      "Facial & Skincare",
      "Makeup",
      "Manicure & Pedicure",
      "Spa & Massage",
    ];

    if (!categories.includes(category)) {
      return res.status(400).send({
        message: 'Invalid category'
      });
    }

    if (
      typeof price !== 'number' ||
      !Number.isFinite(price) ||
      price <= 0 ||
      typeof duration !== 'number' ||
      !Number.isInteger(duration) ||
      duration <= 0
    ) {
      return res.status(400).send({
        message: 'Price and duration must be positive numbers'
      });
    }

    const newService = {
      serviceName: serviceName.trim(),
      category,
      description: description.trim(),
      price,
      duration,
      image,
      status: 'active',
      createdAt: new Date()
    };

    const result = await servicesCollection.insertOne(newService);

    res.status(201).send({
      success: true,
      message: 'Service created successfully',
      insertedId: result.insertedId
    });

  } catch (error) {
    console.error('Service creation failed:', error);

    res.status(500).send({
      success: false,
      message: 'Failed to create service'
    });
  }
});

// http://localhost:5000/services/:id
app.patch('/services/:id', verifyToken, verifyActiveUser, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Validate service ID
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: 'Invalid service ID'
      });
    }

    const {
      serviceName,
      category,
      description,
      price,
      duration,
      image,
      status
    } = req.body;

    const categories = [
      "Haircut & Styling",
      "Hair Coloring",
      "Hair Treatment",
      "Facial & Skincare",
      "Makeup",
      "Manicure & Pedicure",
      "Spa & Massage",
    ];

    // Validate service name
    if (
      serviceName !== undefined &&
      (typeof serviceName !== 'string' || !serviceName.trim())
    ) {
      return res.status(400).send({
        success: false,
        message: 'Service name cannot be empty'
      });
    }

    // Validate category
    if (
      category !== undefined &&
      !categories.includes(category)
    ) {
      return res.status(400).send({
        success: false,
        message: 'Invalid category'
      });
    }

    // Validate description
    if (
      description !== undefined &&
      (typeof description !== 'string' || !description.trim())
    ) {
      return res.status(400).send({
        success: false,
        message: 'Description cannot be empty'
      });
    }

    // Validate price
    if (
      price !== undefined &&
      (
        typeof price !== 'number' ||
        !Number.isFinite(price) ||
        price <= 0
      )
    ) {
      return res.status(400).send({
        success: false,
        message: 'Price must be a positive number'
      });
    }

    // Validate duration
    if (
      duration !== undefined &&
      (
        typeof duration !== 'number' ||
        !Number.isInteger(duration) ||
        duration <= 0
      )
    ) {
      return res.status(400).send({
        success: false,
        message: 'Duration must be a positive integer'
      });
    }

    // Validate image
    if (
      image !== undefined &&
      (typeof image !== 'string' || !image.trim())
    ) {
      return res.status(400).send({
        success: false,
        message: 'Image cannot be empty'
      });
    }

    // Validate status
    if (
      status !== undefined &&
      !['active', 'inactive'].includes(status)
    ) {
      return res.status(400).send({
        success: false,
        message: 'Invalid status'
      });
    }

    // Build update object
    const updateData = {};

    if (serviceName !== undefined) {
      updateData.serviceName = serviceName.trim();
    }

    if (category !== undefined) {
      updateData.category = category;
    }

    if (description !== undefined) {
      updateData.description = description.trim();
    }

    if (price !== undefined) {
      updateData.price = price;
    }

    if (duration !== undefined) {
      updateData.duration = duration;
    }

    if (image !== undefined) {
      updateData.image = image.trim();
    }

    if (status !== undefined) {
      updateData.status = status;
    }

    // Check empty update request
    if (Object.keys(updateData).length === 0) {
      return res.status(400).send({
        success: false,
        message: 'No fields provided for update'
      });
    }

    updateData.updatedAt = new Date();

    // Update service
    const result = await servicesCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    // Check if service exists
    if (result.matchedCount === 0) {
      return res.status(404).send({
        success: false,
        message: 'Service not found'
      });
    }

    res.status(200).send({
      success: true,
      message: 'Service updated successfully'
    });

  } catch (error) {
    console.error('Service update failed:', error);

    res.status(500).send({
      success: false,
      message: 'Failed to update service'
    });
  }
});

// http://localhost:5000/services/:id
app.delete('/services/:id', verifyToken, verifyActiveUser, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: 'Invalid service ID'
      });
    }

    const result = await servicesCollection.deleteOne({
      _id: new ObjectId(id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({
        success: false,
        message: 'Service not found'
      });
    }

    res.send({
      success: true,
      message: 'Service deleted successfully'
    });

  } catch (error) {
    console.error('Service deletion failed:', error);

    res.status(500).send({
      success: false,
      message: 'Failed to delete service'
    });
  }
});

// http://localhost:5000/services/:id
app.get("/services/:id", verifyToken, verifyActiveUser, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID",
      });
    }

    const service = await servicesCollection.findOne({
      _id: new ObjectId(id),
    });

    // Check if service exists
    if (!service) {
      return res.status(404).send({
        success: false,
        message: "Service not found",
      });
    }

    res.status(200).send({
      success: true,
      service,
    });
  } catch (error) {
    console.error("Failed to fetch service:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch service details",
    });
  }
});


// --- Homepage ---
app.get('/featured-services', async (req, res) => {
  try {
    const result = await servicesCollection
      .find({ status: 'active' })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    res.send(result);

  } catch (error) {
    console.error('Featured services fetching failed:', error);

    res.status(500).send({
      success: false,
      message: 'Failed to fetch featured services'
    });
  }
});

// --- appointment ---

// http://localhost:5000/appointments

app.post("/appointments", verifyToken, verifyActiveUser, verifyCustomer, async (req, res) => {
  try {
    const { serviceId, appointmentDate, timeSlot, message } = req.body;

    if (!serviceId || !appointmentDate || !timeSlot) {
      return res.status(400).send({
        success: false,
        message: "Please provide appointment date and time slot.",
      });
    }

    if (!ObjectId.isValid(serviceId)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID.",
      });
    }

    // Get authenticated customer information from JWT
    const customerId = req.user.id;

    const customer = {
      name: req.user.name,
      email: req.user.email,
      image: req.user.image || "",
    };

    // Find service
    const service = await servicesCollection.findOne({
      _id: new ObjectId(serviceId),
    });

    if (!service) {
      return res.status(404).send({
        success: false,
        message: "Service not found.",
      });
    }

    // Check service availability
    if (service.status !== "active") {
      return res.status(400).send({
        success: false,
        message: "This service is currently unavailable.",
      });
    }

    // Check duplicate appointment
    // Check duplicate active appointment
    const existingAppointment = await appointmentsCollection.findOne({
      serviceId,
      appointmentDate,
      timeSlot,
      status: { $in: ["pending", "confirmed"] },
    });

    if (existingAppointment) {
      return res.status(409).send({
        success: false,
        message: "This time slot is already reserved. Please choose another slot.",
      });
    }

    // Create appointment
    const appointmentData = {
      serviceId,
      customerId,
      customer,
      appointmentDate,
      timeSlot,
      message: message || "",
      servicePrice: service.price,
      paymentStatus: "unpaid",
      status: "pending",
      createdAt: new Date(),
    };

    const result = await appointmentsCollection.insertOne(appointmentData);

    res.status(201).send({
      success: true,
      message: "Your appointment request has been submitted successfully!",
      appointmentId: result.insertedId,
    });

  } catch (error) {
    console.error("Appointment creation failed:", error);

    res.status(500).send({
      success: false,
      message: "Failed to submit appointment request.",
    });
  }
});


// --- Get All Appointments (Admin) ---
// GET: http://localhost:5000/appointments

app.get("/appointments", verifyToken, verifyActiveUser, verifyAdmin, async (req, res) => {
  try {
    const appointments = await appointmentsCollection
      .aggregate([
        // Get Customer Information
        {
          $lookup: {
            from: "user",
            let: { customerId: "$customerId" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: [{ $toString: "$_id" }, "$$customerId"],
                  },
                },
              },
              {
                $project: {
                  name: 1,
                  email: 1,
                  image: 1,
                },
              },
            ],
            as: "customer",
          },
        },

        // Get Service Information
        {
          $lookup: {
            from: "services",
            let: { serviceId: "$serviceId" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: [{ $toString: "$_id" }, "$$serviceId"],
                  },
                },
              },
              {
                $project: {
                  serviceName: 1,
                  category: 1,
                  price: 1,
                  duration: 1,
                  image: 1,
                },
              },
            ],
            as: "service",
          },
        },

        // Convert arrays into objects
        {
          $addFields: {
            customer: { $arrayElemAt: ["$customer", 0] },
            service: { $arrayElemAt: ["$service", 0] },
          },
        },

        // Latest appointments first
        {
          $sort: { createdAt: -1 },
        },
      ])
      .toArray();

    res.status(200).send({
      success: true,
      message: "Appointments fetched successfully.",
      appointments,
    });

  } catch (error) {
    console.error("Failed to fetch appointments:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch appointments.",
    });
  }
});

// PATCH: http://localhost:5000/appointments/:id
app.patch("/appointments/:id", verifyToken, verifyActiveUser, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid appointment ID.",
      });
    }

    // Validate Status
    if (!["confirmed", "cancelled"].includes(status)) {
      return res.status(400).send({
        success: false,
        message: "Invalid appointment status.",
      });
    }

    // Find Appointment
    const appointment = await appointmentsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!appointment) {
      return res.status(404).send({
        success: false,
        message: "Appointment not found.",
      });
    }

    // Only Pending Appointments Can Be Confirmed
    if (status === "confirmed" && appointment.status !== "pending") {
      return res.status(400).send({
        success: false,
        message: "Only pending appointments can be confirmed.",
      });
    }

    // Check Slot Conflict Before Confirmation
    if (status === "confirmed") {
      const existingAppointment = await appointmentsCollection.findOne({
        _id: { $ne: new ObjectId(id) },
        serviceId: appointment.serviceId,
        appointmentDate: appointment.appointmentDate,
        timeSlot: appointment.timeSlot,
        status: { $in: ["pending", "confirmed"] },
      });

      if (existingAppointment) {
        return res.status(409).send({
          success: false,
          message:
            "This time slot is already reserved by another appointment.",
        });
      }
    }

    // Only Pending or Confirmed Appointments Can Be Cancelled
    if (
      status === "cancelled" &&
      !["pending", "confirmed"].includes(appointment.status)
    ) {
      return res.status(400).send({
        success: false,
        message: "This appointment cannot be cancelled.",
      });
    }

    // Paid Appointments Cannot Be Cancelled For Now
    if (status === "cancelled" && appointment.paymentStatus === "paid") {
      return res.status(400).send({
        success: false,
        message: "Paid appointments cannot be cancelled.",
      });
    }

    // Update Appointment Status
    const result = await appointmentsCollection.updateOne(
      {
        _id: new ObjectId(id),
        status: appointment.status,
      },
      {
        $set: { status },
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(409).send({
        success: false,
        message: "Appointment status has already been changed.",
      });
    }

    res.status(200).send({
      success: true,
      message:
        status === "confirmed"
          ? "Appointment confirmed successfully."
          : "Appointment cancelled successfully.",
    });
  } catch (error) {
    console.error("Appointment status update failed:", error);

    res.status(500).send({
      success: false,
      message: "Failed to update appointment status.",
    });
  }
});


// --- Get Appointments by OWN (User) ---
// own appointments
app.get("/my-appointments", verifyToken, verifyActiveUser, verifyCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;

    // Find customer's appointments
    const appointments = await appointmentsCollection
      .find({ customerId })
      .sort({ createdAt: -1 })
      .toArray();

    // Attach service information
    const appointmentsWithService = await Promise.all(
      appointments.map(async (appointment) => {
        const service = await servicesCollection.findOne({
          _id: new ObjectId(appointment.serviceId),
        });

        return {
          ...appointment,
          service: service
            ? {
              serviceName: service.serviceName,
              category: service.category,
              price: service.price,
              duration: service.duration,
              image: service.image,
            }
            : null,
        };
      })
    );

    res.status(200).send({
      success: true,
      message: "Your appointments fetched successfully.",
      appointments: appointmentsWithService,
    });

  } catch (error) {
    console.error("My appointments fetch failed:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch your appointments.",
    });
  }
}
);

// own appintment details page
app.get("/my-appointments/:id", verifyToken, verifyActiveUser, verifyCustomer, async (req, res) => {
  try {
    const { id } = req.params;
    const customerId = req.user.id;

    // Validate appointment ID
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid appointment ID.",
      });
    }

    // Find appointment belonging to logged-in customer
    const appointment = await appointmentsCollection.findOne({
      _id: new ObjectId(id),
      customerId,
    });

    if (!appointment) {
      return res.status(404).send({
        success: false,
        message: "Appointment not found.",
      });
    }

    // Find associated service
    const service = await servicesCollection.findOne({
      _id: new ObjectId(appointment.serviceId),
    });

    const appointmentDetails = {
      ...appointment,
      service: service
        ? {
          serviceName: service.serviceName,
          category: service.category,
          price: service.price,
          duration: service.duration,
          image: service.image,
        }
        : null,
    };

    res.status(200).send({
      success: true,
      message: "Appointment details fetched successfully.",
      appointment: appointmentDetails,
    });

  } catch (error) {
    console.error("Appointment details fetch failed:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch appointment details.",
    });
  }
}
);

// to cancel own appointment if status == "pending"
app.patch("/my-appointments/:id/cancel", verifyToken, verifyActiveUser, verifyCustomer, async (req, res) => {
  try {
    const { id } = req.params;
    const customerId = req.user.id;

    // Validate appointment ID
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid appointment ID.",
      });
    }

    // Find customer's appointment
    const appointment = await appointmentsCollection.findOne({
      _id: new ObjectId(id),
      customerId,
    });

    if (!appointment) {
      return res.status(404).send({
        success: false,
        message: "Appointment not found.",
      });
    }

    // Only pending appointments can be cancelled
    if (appointment.status !== "pending") {
      return res.status(400).send({
        success: false,
        message: "Only pending appointments can be cancelled.",
      });
    }

    // Update appointment status
    await appointmentsCollection.updateOne(
      {
        _id: new ObjectId(id),
        customerId,
        status: "pending",
      },
      {
        $set: {
          status: "cancelled",
        },
      }
    );

    res.status(200).send({
      success: true,
      message: "Your appointment has been cancelled successfully.",
    });

  } catch (error) {
    console.error("Appointment cancellation failed:", error);

    res.status(500).send({
      success: false,
      message: "Failed to cancel appointment.",
    });
  }
}
);

// ==== TEST APIs ====
app.get("/protected", verifyToken, (req, res) => {
  res.status(200).json({
    message: "Token verified successfully!",
    user: req.user,
  });
});

app.get("/admin-test", verifyToken, verifyAdmin, (req, res) => {
  res.status(200).json({
    success: true,
    message: "Welcome Admin!",
    user: req.user,
  });
});

// -------------------------------

// ADMIN manage-users
app.get("/users", verifyToken, verifyActiveUser, verifyAdmin, async (req, res) => {
  try {
    // Fetch all registered customers
    const users = await db
      .collection("user")
      .find(
        { role: "user" },
        {
          projection: {
            name: 1,
            email: 1,
            image: 1,
            phone: 1,
            role: 1,
            isBlocked: 1,
            createdAt: 1,
          },
        }
      )
      .sort({ createdAt: -1 })
      .toArray();

    // Add appointment count for each customer
    const usersWithAppointments = await Promise.all(
      users.map(async (user) => {
        const appointmentsCount =
          await appointmentsCollection.countDocuments({
            customerId: user._id.toString(),
          });

        return {
          ...user,
          appointmentsCount,
        };
      })
    );

    res.status(200).send({
      success: true,
      message: "Users fetched successfully.",
      users: usersWithAppointments,
    });
  } catch (error) {
    console.error("Fetch Users Error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch users.",
    });
  }
}
);

app.patch("/users/:id", verifyToken, verifyActiveUser, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { isBlocked } = req.body;

    // Validate user ID
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid user ID.",
      });
    }

    // Validate request body
    if (typeof isBlocked !== "boolean") {
      return res.status(400).send({
        success: false,
        message: "isBlocked must be a boolean value.",
      });
    }

    // Find customer
    const user = await db.collection("user").findOne({
      _id: new ObjectId(id),
      role: "user",
    });

    if (!user) {
      return res.status(404).send({
        success: false,
        message: "Customer not found.",
      });
    }

    // Update customer account status
    const result = await db.collection("user").updateOne(
      {
        _id: user._id,
        role: "user",
      },
      {
        $set: {
          isBlocked,
          updatedAt: new Date(),
        },
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(200).send({
        success: true,
        message: `Customer is already ${isBlocked ? "blocked" : "active"}.`,
      });
    }

    res.status(200).send({
      success: true,
      message: `Customer ${isBlocked ? "blocked" : "unblocked"} successfully.`,
    });
  } catch (error) {
    console.error("Update User Status Error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to update customer status.",
    });
  }
}
);


// ----- Customer profile
app.get("/profile", verifyToken, verifyActiveUser, verifyCustomer, async (req, res) => {
  try {
    const userId = req.user.id;

    const userFilter = ObjectId.isValid(userId)
      ? {
        $or: [
          { _id: userId },
          { _id: new ObjectId(userId) },
        ],
        role: "user",
      }
      : { _id: userId, role: "user" };

    const user = await db.collection("user").findOne(
      userFilter,
      {
        projection: {
          name: 1,
          email: 1,
          image: 1,
          role: 1,
          createdAt: 1,
        },
      }
    );

    if (!user) {
      return res.status(404).send({
        success: false,
        message: "User not found.",
      });
    }

    res.status(200).send({
      success: true,
      user,
    });
  } catch (error) {
    console.error("Get Profile Error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch profile.",
    });
  }
}
);


app.patch("/profile", verifyToken, verifyActiveUser, verifyCustomer, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, image } = req.body;

    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).send({
        success: false,
        message: "Name is required.",
      });
    }

    if (typeof image !== "string") {
      return res.status(400).send({
        success: false,
        message: "Invalid profile image.",
      });
    }

    const userFilter = ObjectId.isValid(userId)
      ? {
        $or: [
          { _id: userId },
          { _id: new ObjectId(userId) },
        ],
        role: "user",
      }
      : {
        _id: userId,
        role: "user",
      };

    const user = await db.collection("user").findOne(userFilter);

    if (!user) {
      return res.status(404).send({
        success: false,
        message: "User not found.",
      });
    }

    await db.collection("user").updateOne(
      { _id: user._id, role: "user" },
      {
        $set: {
          name: name.trim(),
          image,
          updatedAt: new Date(),
        },
      }
    );

    return res.status(200).send({
      success: true,
      message: "Profile updated successfully.",
    });
  } catch (error) {
    console.error("Profile Update Error:", error);

    return res.status(500).send({
      success: false,
      message: "Failed to update profile.",
    });
  }
}
);

//------ admin profile

app.get("/admin/profile", verifyToken, verifyActiveUser, verifyAdmin, async (req, res) => {
  try {
    const userId = req.user.id;

    const adminFilter = ObjectId.isValid(userId)
      ? {
        $or: [
          { _id: userId },
          { _id: new ObjectId(userId) },
        ],
        role: "admin",
      }
      : {
        _id: userId,
        role: "admin",
      };

    const admin = await db
      .collection("user")
      .findOne(adminFilter);

    if (!admin) {
      return res.status(404).send({
        success: false,
        message: "Admin not found.",
      });
    }

    return res.status(200).send({
      success: true,
      user: {
        name: admin.name,
        email: admin.email,
        image: admin.image || "",
        role: admin.role,
        createdAt: admin.createdAt,
      },
    });
  } catch (error) {
    console.error("Admin Profile Fetch Error:", error);

    return res.status(500).send({
      success: false,
      message: "Failed to fetch admin profile.",
    });
  }
}
);

app.patch("/admin/profile", verifyToken, verifyActiveUser, verifyAdmin, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, image } = req.body;

    // Validate name
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).send({
        success: false,
        message: "Name is required.",
      });
    }

    // Validate image
    if (typeof image !== "string") {
      return res.status(400).send({
        success: false,
        message: "Invalid profile image.",
      });
    }

    // Find admin
    const adminFilter = ObjectId.isValid(userId)
      ? {
        $or: [
          { _id: userId },
          { _id: new ObjectId(userId) },
        ],
        role: "admin",
      }
      : {
        _id: userId,
        role: "admin",
      };

    const admin = await db
      .collection("user")
      .findOne(adminFilter);

    if (!admin) {
      return res.status(404).send({
        success: false,
        message: "Admin not found.",
      });
    }

    // Update admin profile
    await db.collection("user").updateOne(
      {
        _id: admin._id,
        role: "admin",
      },
      {
        $set: {
          name: name.trim(),
          image,
          updatedAt: new Date(),
        },
      }
    );

    return res.status(200).send({
      success: true,
      message: "Admin profile updated successfully.",
    });
  } catch (error) {
    console.error("Admin Profile Update Error:", error);

    return res.status(500).send({
      success: false,
      message: "Failed to update admin profile.",
    });
  }
}
);





const PORT = Number(process.env.PORT) || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});