import { Response } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';

function generateMeetLink(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
  const rand = Math.random().toString(36).slice(2, 8);
  return `https://meet.google.com/${slug}-${rand}`;
}

/** Accepts meet.google.com/abc or full https URL */
function normalizeMeetingLink(link: string): string | null {
  const t = link.trim();
  if (!t) return null;
  let u = t;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try {
    const url = new URL(u);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function assertCourseInstructor(db: ReturnType<typeof getDB>, courseId: string, userId: string, role: string) {
  if (!ObjectId.isValid(String(courseId))) return { ok: false as const, status: 400, message: 'Invalid course ID' };
  const course = await db.collection('courses').findOne({ _id: new ObjectId(String(courseId)) });
  if (!course) return { ok: false as const, status: 404, message: 'Course not found' };
  const owner = String((course as any).instructorId ?? (course as any).instructor ?? '');
  if (owner !== userId && role !== 'admin') {
    return { ok: false as const, status: 403, message: 'You can only manage live classes for your own courses' };
  }
  return { ok: true as const };
}

export async function scheduleLiveClass(req: AuthRequest, res: Response) {
  try {
    const { courseId, title, description, scheduledAt, duration, platform, meetingLink: bodyLink } = req.body;
    if (!courseId || !title || !scheduledAt) {
      return res.status(400).json({ success: false, message: 'courseId, title, and scheduledAt are required' });
    }
    if (req.user?.role !== 'instructor' && req.user?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only instructors can schedule live classes' });
    }

    const db = getDB();
    const auth = await assertCourseInstructor(db, String(courseId), req.user!.id, req.user!.role);
    if (!auth.ok) return res.status(auth.status).json({ success: false, message: auth.message });

    const rawCustom = typeof bodyLink === 'string' ? bodyLink.trim() : '';
    let meetingLink: string;
    if (rawCustom) {
      const normalized = normalizeMeetingLink(rawCustom);
      if (!normalized) {
        return res.status(400).json({ success: false, message: 'Invalid meeting link. Use a full URL (https://…)' });
      }
      meetingLink = normalized;
    } else {
      const plat = platform || 'google-meet';
      meetingLink = plat === 'zoom'
        ? `https://zoom.us/j/${Math.floor(Math.random() * 9000000000) + 1000000000}`
        : generateMeetLink(title);
    }

    const now = new Date();
    const doc = {
      courseId: String(courseId),
      instructorId: req.user!.id,
      title: title.trim(),
      description: description?.trim() || '',
      scheduledAt: new Date(scheduledAt),
      duration: Number(duration) || 60,
      platform: rawCustom ? 'custom' : (platform || 'google-meet'),
      meetingLink,
      status: 'scheduled',
      attendees: [],
      rsvps: [] as string[],
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection('liveclasses').insertOne(doc);

    const enrollments = await db.collection('enrollments').find({ course: String(courseId) }).toArray();
    const notifications = enrollments.map((e: any) => ({
      userId: e.student,
      type: 'liveclass',
      title: 'Live Class Scheduled',
      message: `"${title}" scheduled for ${new Date(scheduledAt).toLocaleDateString()} at ${new Date(scheduledAt).toLocaleTimeString()}`,
      read: false,
      link: '/dashboard',
      createdAt: now,
    }));
    if (notifications.length > 0) await db.collection('notifications').insertMany(notifications);

    res.status(201).json({
      success: true, message: 'Live class scheduled',
      classId: result.insertedId.toString(), meetingLink,
    });
  } catch (e) {
    console.error('scheduleLiveClass', e);
    res.status(500).json({ success: false, message: 'Failed to schedule class' });
  }
}

export async function getLiveClasses(req: AuthRequest, res: Response) {
  try {
    const { courseId, upcoming } = req.query;
    const db = getDB();

    const filter: Record<string, unknown> = {};
    if (courseId) filter.courseId = String(courseId);
    if (upcoming === 'true') filter.scheduledAt = { $gte: new Date() };

    const docs = await db.collection('liveclasses')
      .find(filter)
      .sort({ scheduledAt: 1 })
      .toArray();

    res.json({ success: true, liveClasses: docs.map(mapClass) });
  } catch (e) {
    console.error('getLiveClasses', e);
    res.status(500).json({ success: false, message: 'Failed to load classes' });
  }
}

export async function getMyLiveClasses(req: AuthRequest, res: Response) {
  try {
    const db = getDB();
    const userId = req.user!.id;

    let docs;
    if (req.user!.role === 'instructor') {
      docs = await db.collection('liveclasses')
        .find({ instructorId: userId })
        .sort({ scheduledAt: -1 })
        .toArray();
    } else {
      const enrollments = await db.collection('enrollments').find({ student: userId }).toArray();
      const courseIds = enrollments.map((e: any) => e.course);
      docs = await db.collection('liveclasses')
        .find({ courseId: { $in: courseIds } })
        .sort({ scheduledAt: 1 })
        .toArray();
    }

    const liveClasses = docs.map((d) => ({
      ...mapClass(d),
      hasRsvped: Array.isArray(d.rsvps) && d.rsvps.includes(userId),
    }));

    res.json({ success: true, liveClasses });
  } catch (e) {
    console.error('getMyLiveClasses', e);
    res.status(500).json({ success: false, message: 'Failed to load classes' });
  }
}

export async function markAttendance(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid ID' });

    const db = getDB();
    const userId = req.user!.id;
    const cls = await db.collection('liveclasses').findOne({ _id: new ObjectId(id) });
    if (!cls) return res.status(404).json({ success: false, message: 'Class not found' });

    const canJoin =
      cls.instructorId === userId ||
      req.user!.role === 'admin' ||
      !!(await db.collection('enrollments').findOne({ student: userId, course: String(cls.courseId) }));
    if (!canJoin) {
      return res.status(403).json({ success: false, message: 'Enroll in this course to join the live class' });
    }

    await db.collection('liveclasses').updateOne(
      { _id: new ObjectId(id) },
      { $addToSet: { attendees: userId } as any }
    );

    await db.collection('activity').insertOne({
      userId, type: 'live_class_attendance', classId: id, timestamp: new Date(),
    });

    res.json({ success: true, message: 'Attendance marked' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to mark attendance' });
  }
}

export async function rsvpLiveClass(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const going = req.body?.going !== false;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid ID' });

    const db = getDB();
    const userId = req.user!.id;
    const cls = await db.collection('liveclasses').findOne({ _id: new ObjectId(id) });
    if (!cls) return res.status(404).json({ success: false, message: 'Class not found' });

    const enrolled = await db.collection('enrollments').findOne({ student: userId, course: String(cls.courseId) });
    if (!enrolled && req.user!.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Enroll in this course to RSVP' });
    }

    if (going) {
      await db.collection('liveclasses').updateOne(
        { _id: new ObjectId(id) },
        { $addToSet: { rsvps: userId } as any, $set: { updatedAt: new Date() } }
      );
    } else {
      await db.collection('liveclasses').updateOne(
        { _id: new ObjectId(id) },
        { $pull: { rsvps: userId } as any, $set: { updatedAt: new Date() } }
      );
    }

    const fresh = await db.collection('liveclasses').findOne({ _id: new ObjectId(id) });
    const rsvpCount = (fresh?.rsvps || []).length;

    res.json({
      success: true,
      message: going ? "You're on the list" : 'RSVP removed',
      hasRsvped: going,
      rsvpCount,
    });
  } catch (e) {
    console.error('rsvpLiveClass', e);
    res.status(500).json({ success: false, message: 'Failed to update RSVP' });
  }
}

export async function updateLiveClass(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid ID' });

    const db = getDB();
    const existing = await db.collection('liveclasses').findOne({ _id: new ObjectId(id) });
    if (!existing) return res.status(404).json({ success: false, message: 'Class not found' });
    if (existing.instructorId !== req.user!.id && req.user!.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized to edit this live class' });
    }

    const { status, title, description, scheduledAt, duration, platform, meetingLink: bodyLink } = req.body;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (status) updates.status = status;
    if (title?.trim()) updates.title = title.trim();
    if (description !== undefined) updates.description = String(description).trim();
    if (scheduledAt) updates.scheduledAt = new Date(scheduledAt);
    if (duration !== undefined) {
      const n = Number(duration);
      if (!Number.isNaN(n) && n > 0) updates.duration = n;
    }
    if (platform) updates.platform = platform;
    if (bodyLink !== undefined) {
      const raw = String(bodyLink).trim();
      if (!raw) {
        return res.status(400).json({ success: false, message: 'Meeting link cannot be empty. Paste a valid URL or regenerate from schedule flow.' });
      }
      const normalized = normalizeMeetingLink(raw);
      if (!normalized) {
        return res.status(400).json({ success: false, message: 'Invalid meeting link' });
      }
      updates.meetingLink = normalized;
    }

    await db.collection('liveclasses').updateOne({ _id: new ObjectId(id) }, { $set: updates });
    res.json({ success: true, message: 'Updated' });
  } catch (e) {
    console.error('updateLiveClass', e);
    res.status(500).json({ success: false, message: 'Failed to update' });
  }
}

export async function deleteLiveClass(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid ID' });

    const db = getDB();
    const existing = await db.collection('liveclasses').findOne({ _id: new ObjectId(id) });
    if (!existing) return res.status(404).json({ success: false, message: 'Class not found' });
    if (existing.instructorId !== req.user!.id && req.user!.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this live class' });
    }

    await db.collection('liveclasses').deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: 'Live class deleted' });
  } catch (e) {
    console.error('deleteLiveClass', e);
    res.status(500).json({ success: false, message: 'Failed to delete' });
  }
}

function mapClass(d: any) {
  return {
    id: d._id.toString(),
    courseId: d.courseId,
    instructorId: d.instructorId,
    title: d.title,
    description: d.description,
    scheduledAt: d.scheduledAt,
    duration: d.duration,
    platform: d.platform,
    meetingLink: d.meetingLink,
    status: d.status,
    attendeeCount: (d.attendees || []).length,
    rsvpCount: (d.rsvps || []).length,
    createdAt: d.createdAt,
  };
}
