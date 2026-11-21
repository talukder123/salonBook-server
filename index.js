import 'dotenv/config'
import { MongoClient, ObjectId  } from "mongodb";

import express from 'express';
import cors from 'cors';

const app = express();

// middleware!
app.use(cors())
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
const appointmentsCollection = db.collection("appointments")
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


app.listen(process.env.PORT || 5000, () => {
  console.log("Server is cooking on port 5000");
})