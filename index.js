import 'dotenv/config'
import { MongoClient, ObjectId } from "mongodb";

import express from 'express';
import cors from 'cors';

import verifyToken from "./middlewares/verifyToken.js";
import verifyAdmin from "./middlewares/verifyAdmin.js";
import verifyCustomer from './middlewares/verifyCustomer.js';

const app = express();

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

// Database collections --
const servicesCollection = db.collection("services")
const appointmentsCollection = db.collection("appointments");
const transactionsCollection = db.collection("transactions")


// http://localhost:5000/services
app.get('/services', async (req, res) => {
  try {
    const { category } = req.query;

    const filter = category ? { category } : {};

    const result = await servicesCollection.find(filter).toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({
      message: "Failed to fetch services"
    });
  }
});

// http://localhost:5000/services
app.post('/services', async (req, res) => {
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
app.patch('/services/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
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

    if (category && !categories.includes(category)) {
      return res.status(400).send({
        message: 'Invalid category'
      });
    }

    if (
      price !== undefined &&
      (typeof price !== 'number' || !Number.isFinite(price) || price <= 0)
    ) {
      return res.status(400).send({
        message: 'Price must be a positive number'
      });
    }

    if (
      duration !== undefined &&
      (!Number.isInteger(duration) || duration <= 0)
    ) {
      return res.status(400).send({
        message: 'Duration must be a positive integer'
      });
    }

    if (status !== undefined && !['active', 'inactive'].includes(status)) {
      return res.status(400).send({
        message: 'Invalid status'
      });
    }

    const updateData = {};

    if (serviceName !== undefined) updateData.serviceName = serviceName.trim();
    if (category !== undefined) updateData.category = category;
    if (description !== undefined) updateData.description = description.trim();
    if (price !== undefined) updateData.price = price;
    if (duration !== undefined) updateData.duration = duration;
    if (image !== undefined) updateData.image = image;
    if (status !== undefined) updateData.status = status;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).send({
        message: 'No fields provided for update'
      });
    }

    updateData.updatedAt = new Date();

    const result = await servicesCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    if (!result.matchedCount) {
      return res.status(404).send({
        message: 'Service not found'
      });
    }

    res.send({
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
app.delete('/services/:id', async (req, res) => {
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
app.get("/services/:id", async (req, res) => {
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

app.post("/appointments", verifyToken, verifyCustomer, async (req, res) => {
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
    const existingAppointment = await appointmentsCollection.findOne({
      serviceId,
      appointmentDate,
      timeSlot,
      $or: [
        { status: "confirmed" },
        { customerId, status: "pending" },
      ],
    });

    if (existingAppointment) {
      return res.status(409).send({
        success: false,
        message: "This time slot is already booked or requested.",
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

app.get("/appointments", async (req, res) => {
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
app.patch("/appointments/:id", async (req, res) => {
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

    // Update Appointment Status
    await appointmentsCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status,
        },
      }
    );

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


// --- GET appointment by User ---

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



const PORT = Number(process.env.PORT) || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});