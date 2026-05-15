import { MongoClient, Db } from 'mongodb';
import { seedCoursesIfEmpty } from './seedCourses.js';

let client: MongoClient | null = null;
let db: Db | null = null;

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/edu-rev';

export async function connectDB(): Promise<Db> {
  try {
    if (db) {
      console.log('✅ Using existing MongoDB connection');
      return db;
    }

    client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('edu-rev');

    console.log('✅ MongoDB connected successfully');
    
    // Create indexes for better query performance
    await createIndexes();

    await seedCoursesIfEmpty(db);

    return db;
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error);
    throw error;
  }
}

async function createIndexes() {
  if (!db) return;

  try {
    // Users collection indexes
    const usersCollection = db.collection('users');
    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await usersCollection.createIndex({ role: 1 });

    // Courses collection indexes
    const coursesCollection = db.collection('courses');
    await coursesCollection.createIndex({ instructor: 1 });
    await coursesCollection.createIndex({ status: 1 });
    await coursesCollection.createIndex({ createdAt: -1 });

    // Enrollments collection indexes
    const enrollmentsCollection = db.collection('enrollments');
    await enrollmentsCollection.createIndex({ student: 1, course: 1 }, { unique: true });
    await enrollmentsCollection.createIndex({ status: 1 });

    // Assignments collection indexes
    const assignmentsCollection = db.collection('assignments');
    await assignmentsCollection.createIndex({ course: 1 });
    await assignmentsCollection.createIndex({ dueDate: 1 });

    try {
      const reviewsCollection = db.collection('reviews');
      await reviewsCollection.createIndex({ courseId: 1, userId: 1 }, { unique: true });
    } catch (e) {
      console.warn('reviews compound unique index (ok if duplicates existed):', (e as Error).message);
    }

    console.log('✅ Database indexes created');
  } catch (error) {
    console.error('Warning: Index creation failed:', error);
  }
}

export function getDB(): Db {
  if (!db) {
    throw new Error('Database not initialized. Call connectDB first.');
  }
  return db;
}

export async function closeDB() {
  if (client) {
    await client.close();
    db = null;
    console.log('📌 MongoDB connection closed');
  }
}

export default connectDB;
