import { Response } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';

export async function getNotifications(req: AuthRequest, res: Response) {
  try {
    const db = getDB();
    const userId = req.user!.id;
    const limit = Number(req.query.limit) || 20;

    const notifications = await db.collection('notifications')
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    const unreadCount = await db.collection('notifications').countDocuments({ userId, read: false });

    const mapped = notifications.map((n: any) => ({
      id: n._id.toString(),
      type: n.type,
      title: n.title,
      message: n.message,
      read: n.read,
      link: n.link,
      createdAt: n.createdAt,
    }));

    res.json({ success: true, notifications: mapped, unreadCount });
  } catch (e) {
    console.error('getNotifications', e);
    res.status(500).json({ success: false, message: 'Failed to load notifications' });
  }
}

export async function markRead(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid ID' });
    const db = getDB();
    await db.collection('notifications').updateOne(
      { _id: new ObjectId(id), userId: req.user!.id },
      { $set: { read: true } }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to mark as read' });
  }
}

export async function markAllRead(req: AuthRequest, res: Response) {
  try {
    const db = getDB();
    await db.collection('notifications').updateMany(
      { userId: req.user!.id, read: false },
      { $set: { read: true } }
    );
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to mark as read' });
  }
}

export async function deleteNotification(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid ID' });
    const db = getDB();
    await db.collection('notifications').deleteOne({ _id: new ObjectId(id), userId: req.user!.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to delete' });
  }
}
