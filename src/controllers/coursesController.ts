import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';

export async function listCourses(_req: Request, res: Response) {
  try {
    const db = getDB();
    const docs = await db
      .collection('courses')
      .find({ status: { $in: ['published'] } })
      .sort({ createdAt: -1 })
      .toArray();

    const courses = docs.map(mapCourse);
    res.json({ success: true, courses });
  } catch (e) {
    console.error('listCourses', e);
    res.status(500).json({ success: false, message: 'Failed to load courses' });
  }
}

export async function getCourse(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid course ID' });
    }
    const db = getDB();
    const doc = await db.collection('courses').findOne({ _id: new ObjectId(id) });
    if (!doc) return res.status(404).json({ success: false, message: 'Course not found' });

    res.json({ success: true, course: mapCourse(doc) });
  } catch (e) {
    console.error('getCourse', e);
    res.status(500).json({ success: false, message: 'Failed to load course' });
  }
}

export async function createCourse(req: AuthRequest, res: Response) {
  try {
    const { title, description, category, difficulty, price, isFree, modules } = req.body;

    if (!title?.trim() || !description?.trim() || !category?.trim()) {
      return res.status(400).json({ success: false, message: 'Title, description, and category are required' });
    }

    if (req.user?.role !== 'instructor' && req.user?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only instructors can create courses' });
    }

    const db = getDB();
    const thumbnailPath = (req.file as any)?.filename
      ? `/uploads/thumbnails/${(req.file as any).filename}`
      : null;

    let parsedModules: any[] = [];
    if (modules) {
      try {
        parsedModules = typeof modules === 'string' ? JSON.parse(modules) : modules;
      } catch {
        parsedModules = [];
      }
    }

    const now = new Date();
    const doc = {
      title: title.trim(),
      description: description.trim(),
      category: category.trim(),
      difficulty: difficulty || 'beginner',
      price: isFree === 'true' || isFree === true ? 0 : Number(price) || 0,
      isFree: isFree === 'true' || isFree === true,
      thumbnail: thumbnailPath,
      instructorId: req.user!.id,
      instructorName: req.user!.email,
      modules: parsedModules.map((m: any, idx: number) => ({
        id: `module-${idx + 1}`,
        title: m.title || `Module ${idx + 1}`,
        description: m.description || '',
        lessons: (m.lessons || []).map((l: any, li: number) => ({
          id: `lesson-${idx + 1}-${li + 1}`,
          title: l.title || `Lesson ${li + 1}`,
          type: l.type === 'file' ? 'file' : 'video',
          content: l.content || '',
          videoUrl: l.videoUrl || '',
          duration: l.duration || 0,
        })),
        order: idx + 1,
      })),
      status: 'published',
      rating: 0,
      reviewCount: 0,
      enrollmentCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection('courses').insertOne(doc);
    res.status(201).json({
      success: true,
      message: 'Course created successfully',
      courseId: result.insertedId.toString(),
      course: { ...doc, id: result.insertedId.toString() }
    });
  } catch (e) {
    console.error('createCourse', e);
    res.status(500).json({ success: false, message: 'Failed to create course' });
  }
}

export async function updateCourse(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid course ID' });
    }

    const db = getDB();
    const existing = await db.collection('courses').findOne({ _id: new ObjectId(id) });
    if (!existing) return res.status(404).json({ success: false, message: 'Course not found' });

    if (existing.instructorId !== req.user!.id && req.user!.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized to update this course' });
    }

    const { title, description, category, difficulty, price, isFree, modules, status } = req.body;
    const updates: any = { updatedAt: new Date() };

    if (title?.trim()) updates.title = title.trim();
    if (description?.trim()) updates.description = description.trim();
    if (category?.trim()) updates.category = category.trim();
    if (difficulty) updates.difficulty = difficulty;
    if (status) updates.status = status;
    if (isFree !== undefined) {
      updates.isFree = isFree === 'true' || isFree === true;
      updates.price = updates.isFree ? 0 : Number(price) || existing.price || 0;
    }
    if ((req.file as any)?.filename) {
      updates.thumbnail = `/uploads/thumbnails/${(req.file as any).filename}`;
    }
    if (modules) {
      try {
        const parsedModules = typeof modules === 'string' ? JSON.parse(modules) : modules;
        updates.modules = parsedModules.map((m: any, idx: number) => ({
          id: m.id || `module-${idx + 1}`,
          title: m.title || `Module ${idx + 1}`,
          description: m.description || '',
          lessons: (m.lessons || []).map((l: any, li: number) => ({
            id: l.id || `lesson-${idx + 1}-${li + 1}`,
            title: l.title || `Lesson ${li + 1}`,
            type: l.type === 'file' ? 'file' : 'video',
            content: l.content || '',
            videoUrl: l.videoUrl || '',
            duration: l.duration || 0,
          })),
          order: idx + 1,
        }));
      } catch { /* skip */ }
    }

    await db.collection('courses').updateOne({ _id: new ObjectId(id) }, { $set: updates });
    res.json({ success: true, message: 'Course updated successfully' });
  } catch (e) {
    console.error('updateCourse', e);
    res.status(500).json({ success: false, message: 'Failed to update course' });
  }
}

export async function deleteCourse(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid course ID' });
    }

    const db = getDB();
    const existing = await db.collection('courses').findOne({ _id: new ObjectId(id) });
    if (!existing) return res.status(404).json({ success: false, message: 'Course not found' });

    if (existing.instructorId !== req.user!.id && req.user!.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this course' });
    }

    await db.collection('courses').deleteOne({ _id: new ObjectId(id) });
    await db.collection('enrollments').deleteMany({ course: id });
    await db.collection('assignments').updateMany(
      { courseId: id },
      { $set: { status: 'deleted', updatedAt: new Date() } }
    );

    res.json({ success: true, message: 'Course deleted successfully' });
  } catch (e) {
    console.error('deleteCourse', e);
    res.status(500).json({ success: false, message: 'Failed to delete course' });
  }
}

export async function getInstructorCourses(req: AuthRequest, res: Response) {
  try {
    const db = getDB();
    const docs = await db
      .collection('courses')
      .find({ instructorId: req.user!.id })
      .sort({ createdAt: -1 })
      .toArray();

    const courseIds = docs.map(d => d._id.toString());
    const countMap = new Map<string, number>();
    if (courseIds.length > 0) {
      const agg = await db.collection('assignments').aggregate([
        { $match: { courseId: { $in: courseIds }, status: 'active' } },
        { $group: { _id: '$courseId', n: { $sum: 1 } } },
      ]).toArray();
      for (const row of agg) {
        countMap.set(String((row as any)._id), (row as any).n);
      }
    }

    const courses = docs.map((d) => {
      const base = mapCourse(d);
      return { ...base, assignmentCount: countMap.get(base.id) ?? base.assignmentCount };
    });
    res.json({ success: true, courses });
  } catch (e) {
    console.error('getInstructorCourses', e);
    res.status(500).json({ success: false, message: 'Failed to load courses' });
  }
}

function mapCourse(d: any) {
  return {
    id: d._id.toString(),
    title: d.title as string,
    description: d.description as string,
    category: d.category as string,
    instructorId: (d.instructorId ?? d.instructor ?? '') as string,
    instructorName: (d.instructorName ?? '') as string,
    price: typeof d.price === 'number' ? d.price : 0,
    isFree: Boolean(d.isFree ?? true),
    thumbnail: d.thumbnail as string | undefined,
    difficulty: (d.difficulty ?? d.level ?? 'beginner') as string,
    modules: Array.isArray(d.modules) ? d.modules : [],
    rating: typeof d.rating === 'number' ? d.rating : 0,
    reviewCount: typeof d.reviewCount === 'number' ? d.reviewCount : 0,
    enrollmentCount: typeof d.enrollmentCount === 'number' ? d.enrollmentCount : 0,
    status: d.status as string,
    createdAt: d.createdAt,
    assignmentCount: Array.isArray(d.assignmentIds) ? d.assignmentIds.length : 0,
  };
}
