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
app.get('/services', (req, res) => {
    const result = servicesCollection.find().toArray();
    res.send(result)
})



app.listen(process.env.PORT || 5000, ()=> {
    console.log("Server is cooking on port 5000");
})