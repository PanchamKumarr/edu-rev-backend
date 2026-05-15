import { Response } from 'express';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';

async function assertEnrolled(userId: string, courseId: string): Promise<boolean> {
  const db = getDB();
  const enr = await db.collection('enrollments').findOne({ student: userId, course: courseId });
  return !!enr;
}

export async function getPersonalLessonNote(req: AuthRequest, res: Response) {
  try {
    const { courseId, lessonId } = req.params;
    const userId = req.user!.id;

    const ok = await assertEnrolled(userId, courseId);
    if (!ok) {
      return res.status(403).json({ success: false, message: 'Not enrolled in this course' });
    }

    const db = getDB();
    const doc = await db.collection('lessonPersonalNotes').findOne({ userId, courseId, lessonId });
    res.json({ success: true, text: typeof doc?.text === 'string' ? doc.text : '' });
  } catch (e) {
    console.error('getPersonalLessonNote', e);
    res.status(500).json({ success: false, message: 'Failed to load notes' });
  }
}

export async function savePersonalLessonNote(req: AuthRequest, res: Response) {
  try {
    const { courseId, lessonId } = req.params;
    const userId = req.user!.id;
    const { text } = req.body;
    const textStr = typeof text === 'string' ? text : '';

    if (!lessonId || lessonId.length > 512) {
      return res.status(400).json({ success: false, message: 'Invalid lesson id' });
    }

    const ok = await assertEnrolled(userId, courseId);
    if (!ok) {
      return res.status(403).json({ success: false, message: 'Not enrolled in this course' });
    }

    const db = getDB();
    const now = new Date();
    await db.collection('lessonPersonalNotes').updateOne(
      { userId, courseId, lessonId },
      { $set: { userId, courseId, lessonId, text: textStr, updatedAt: now } },
      { upsert: true }
    );

    res.json({ success: true });
  } catch (e) {
    console.error('savePersonalLessonNote', e);
    res.status(500).json({ success: false, message: 'Failed to save notes' });
  }
}
