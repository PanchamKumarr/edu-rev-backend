import { Response } from 'express';
import { ObjectId } from 'mongodb';
import crypto from 'crypto';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';

// ─── Create Order (Mock Payment) ─────────────────────────────────────────────
export async function createOrder(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.body;
    const userId = req.user!.id;

    if (!courseId) return res.status(400).json({ success: false, message: 'courseId required' });

    const db = getDB();
    if (!ObjectId.isValid(courseId)) return res.status(400).json({ success: false, message: 'Invalid courseId' });

    const course = await db.collection('courses').findOne({ _id: new ObjectId(courseId) });
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

    if (course.isFree) {
      return res.status(400).json({ success: false, message: 'This course is free. Use enrollment endpoint instead.' });
    }

    // Check if already purchased
    const existing = await db.collection('orders').findOne({ userId, courseId, status: 'completed' });
    if (existing) return res.status(409).json({ success: false, message: 'Course already purchased' });

    const orderId = 'ORD-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const now = new Date();
    const doc = {
      orderId,
      userId,
      courseId,
      courseTitle: course.title,
      amount: course.price,
      currency: 'USD',
      status: 'pending',
      paymentMethod: null,
      createdAt: now,
      updatedAt: now,
    };

    await db.collection('orders').insertOne(doc);
    res.status(201).json({
      success: true,
      order: { orderId, amount: course.price, currency: 'USD', courseTitle: course.title },
      message: 'Order created. Complete payment to enroll.',
    });
  } catch (e) {
    console.error('createOrder', e);
    res.status(500).json({ success: false, message: 'Failed to create order' });
  }
}

// ─── Complete Order (Mock Payment Success) ────────────────────────────────────
export async function completeOrder(req: AuthRequest, res: Response) {
  try {
    const { orderId } = req.params;
    const { paymentMethod = 'mock_card' } = req.body;
    const userId = req.user!.id;

    const db = getDB();
    const order = await db.collection('orders').findOne({ orderId, userId });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status === 'completed') return res.status(409).json({ success: false, message: 'Order already completed' });

    const now = new Date();
    await db.collection('orders').updateOne(
      { orderId, userId },
      { $set: { status: 'completed', paymentMethod, completedAt: now, updatedAt: now } }
    );

    // Auto-enroll after payment
    const alreadyEnrolled = await db.collection('enrollments').findOne({ student: userId, course: order.courseId });
    if (!alreadyEnrolled) {
      await db.collection('enrollments').insertOne({
        student: userId, course: order.courseId,
        progress: 0, completedModules: [], status: 'active',
        enrolledAt: now, lastAccessed: now, paidEnrollment: true, orderId,
      });
    }

    await db.collection('notifications').insertOne({
      userId, type: 'payment',
      title: 'Payment Successful!',
      message: `You're now enrolled in "${order.courseTitle}"`,
      read: false, link: '/dashboard', createdAt: now,
    });

    res.json({ success: true, message: 'Payment successful! You are now enrolled.', enrolled: true });
  } catch (e) {
    console.error('completeOrder', e);
    res.status(500).json({ success: false, message: 'Failed to complete order' });
  }
}

// ─── Get My Orders ─────────────────────────────────────────────────────────────
export async function getMyOrders(req: AuthRequest, res: Response) {
  try {
    const db = getDB();
    const orders = await db.collection('orders')
      .find({ userId: req.user!.id })
      .sort({ createdAt: -1 })
      .toArray();

    const mapped = orders.map((o: any) => ({
      id: o._id.toString(),
      orderId: o.orderId,
      courseId: o.courseId,
      courseTitle: o.courseTitle,
      amount: o.amount,
      currency: o.currency,
      status: o.status,
      paymentMethod: o.paymentMethod,
      createdAt: o.createdAt,
      completedAt: o.completedAt,
    }));

    res.json({ success: true, orders: mapped });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load orders' });
  }
}
