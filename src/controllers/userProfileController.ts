import { Response } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';
import type { IInsightsProfile } from '../models/index.js';

const INSIGHTS_KEYS = [
  'careerOrStudyGoal',
  'weeklyStudyHours',
  'subjectsOfInterest',
  'learningChallenges',
  'preferredFormats',
] as const;

function sanitizeProfile(body: unknown): IInsightsProfile {
  const src = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const out: IInsightsProfile = {};
  for (const key of INSIGHTS_KEYS) {
    const raw = src[key];
    if (typeof raw !== 'string') continue;
    const t = raw.trim().slice(0, 4000);
    if (t) (out as Record<string, string>)[key] = t;
  }
  return out;
}

export async function getMyProfile(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user' });
    }
    const doc = await getDB()
      .collection('users')
      .findOne({ _id: new ObjectId(userId) }, { projection: { password: 0 } });

    if (!doc) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        id: doc._id!.toString(),
        email: doc.email,
        name: doc.name,
        role: doc.role,
        createdAt: doc.createdAt,
        insightsProfile: doc.insightsProfile || {},
      },
    });
  } catch (e) {
    console.error('getMyProfile', e);
    res.status(500).json({ success: false, message: 'Failed to load profile' });
  }
}

export async function updateMyProfile(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user' });
    }

    const raw = (req.body as { name?: unknown })?.name;
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name) {
      return res.status(400).json({ success: false, message: 'Full name is required' });
    }
    if (name.length > 120) {
      return res.status(400).json({ success: false, message: 'Full name must be 120 characters or less' });
    }

    const db = getDB();
    const now = new Date();
    const doc = await db.collection('users').findOneAndUpdate(
      { _id: new ObjectId(userId) },
      { $set: { name, updatedAt: now } },
      { returnDocument: 'after', projection: { password: 0 } }
    );

    if (!doc) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        id: doc._id!.toString(),
        email: doc.email,
        name: doc.name,
        role: doc.role,
        createdAt: doc.createdAt,
        insightsProfile: doc.insightsProfile || {},
      },
    });
  } catch (e) {
    console.error('updateMyProfile', e);
    res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
}

export async function updateInsightsProfile(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user' });
    }

    const insightsProfile = sanitizeProfile(req.body?.insightsProfile ?? req.body);
    const db = getDB();
    const now = new Date();

    const doc = await db.collection('users').findOneAndUpdate(
      { _id: new ObjectId(userId) },
      { $set: { insightsProfile, updatedAt: now } },
      { returnDocument: 'after', projection: { password: 0 } }
    );

    if (!doc) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = {
      id: doc._id!.toString(),
      email: doc.email,
      name: doc.name,
      role: doc.role,
      createdAt: doc.createdAt,
      insightsProfile: doc.insightsProfile || {},
    };

    res.json({ success: true, user });
  } catch (e) {
    console.error('updateInsightsProfile', e);
    res.status(500).json({ success: false, message: 'Failed to save profile' });
  }
}
