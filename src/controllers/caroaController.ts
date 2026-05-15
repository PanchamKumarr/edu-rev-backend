import { Response } from 'express';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';

export async function getCaroaContext(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const db = getDB();

    const masterySnap = await db.collection('mastery').find({ userId }).toArray();
    const masteryProfile = masterySnap.map((d) => ({
      userId: d.userId,
      topicId: d.topicId,
      level: typeof d.level === 'number' ? d.level : 0.5
    }));

    const coursesSnap = await db.collection('courses').find({}).toArray();
    const allModules = coursesSnap.flatMap((d) => {
      const mods = (d.modules as unknown[]) || [];
      return mods.map((m: any) => ({
        ...m,
        courseTitle: d.title,
        courseId: d._id.toString()
      }));
    });

    const enrollSnap = await db.collection('enrollments').find({ student: userId }).toArray();
    const completedModuleIds = enrollSnap.flatMap((d) => (d.completedModules as string[]) || []);

    const availableModules = allModules.filter((m) => m.id && !completedModuleIds.includes(m.id));

    res.json({
      success: true,
      userId,
      masteryProfile,
      availableModules
    });
  } catch (e) {
    console.error('getCaroaContext', e);
    res.status(500).json({ success: false, message: 'Failed to build CAROA context' });
  }
}

export async function postMastery(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const { topicId, performanceDelta } = req.body as {
      topicId?: string;
      performanceDelta?: number;
    };

    if (!topicId || typeof performanceDelta !== 'number') {
      return res.status(400).json({ success: false, message: 'topicId and performanceDelta are required' });
    }

    const db = getDB();
    const col = db.collection('mastery');
    const key = { userId, topicId };
    const existing = await col.findOne(key);

    let currentLevel = 0.5;
    if (existing && typeof existing.level === 'number') {
      currentLevel = existing.level;
    }

    const newLevel = Math.max(0, Math.min(1, currentLevel + performanceDelta));

    await col.updateOne(
      key,
      {
        $set: {
          userId,
          topicId,
          level: newLevel,
          lastUpdated: new Date()
        }
      },
      { upsert: true }
    );

    res.json({ success: true, level: newLevel });
  } catch (e) {
    console.error('postMastery', e);
    res.status(500).json({ success: false, message: 'Failed to update mastery' });
  }
}

export async function postActivity(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const db = getDB();
    await db.collection('activity').insertOne({
      userId,
      ...(typeof req.body === 'object' && req.body !== null ? req.body : {}),
      timestamp: new Date()
    });
    res.json({ success: true });
  } catch (e) {
    console.error('postActivity', e);
    res.status(500).json({ success: false, message: 'Failed to log activity' });
  }
}
