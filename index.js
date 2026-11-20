import 'dotenv/config'
import { MongoClient } from "mongodb";

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


// /services
app.get('/services', async(req, res) => {
    const result = await servicesCollection.find().toArray();
    res.send(result)
})

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
      !serviceName ||
      !category ||
      !description ||
      !image ||
      price === undefined ||
      duration === undefined
    ) {
      return res.status(400).send({
        message: 'All fields are required'
      });
    }

    // Validate price and duration
    if (
      typeof price !== 'number' ||
      price <= 0 ||
      typeof duration !== 'number' ||
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



app.listen(process.env.PORT || 5000, ()=> {
    console.log("Server is cooking on port 5000");
})