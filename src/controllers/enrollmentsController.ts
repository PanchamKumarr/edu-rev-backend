import { Response } from 'express';
import { Db, ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';

/** Lesson keys as in enrollment.completedModules (same rule as frontend: lesson id or "moduleIndex-lessonIndex"). */
function lessonKeysFromCourse(course: { modules?: unknown[] } | null): string[] {
  const modules = Array.isArray(course?.modules) ? course.modules : [];
  const keys: string[] = [];
  modules.forEach((mod: unknown, mi: number) => {
    const m = mod as { lessons?: unknown[] };
    const lessons = Array.isArray(m?.lessons) ? m.lessons : [];
    lessons.forEach((les: unknown, li: number) => {
      const lesson = les as { id?: unknown };
      const raw = lesson?.id;
      const id = raw != null && String(raw).trim() !== '' ? String(raw) : `${mi}-${li}`;
      keys.push(id);
    });
  });
  return keys;
}

/** New completions require a passed quiz attempt; existing completions are kept (legacy data). */
async function filterCompletedByPassedQuiz(
  db: Db,
  userId: string,
  courseId: string,
  incoming: string[],
  prevSet: Set<string>
): Promise<string[]> {
  const needProof = incoming.filter((id) => !prevSet.has(id));
  if (needProof.length === 0) return incoming;

  const passedDocs = await db
    .collection('courseQuizAttempts')
    .find({ userId, courseId, passed: true, lessonId: { $in: needProof } })
    .project({ lessonId: 1 })
    .toArray();
  const passedSet = new Set(passedDocs.map((d) => String((d as { lessonId?: string }).lessonId)));

  return incoming.filter((id) => prevSet.has(id) || passedSet.has(id));
}

export async function listMyEnrollments(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const db = getDB();

    const enrollmentDocs = await db.collection('enrollments').find({ student: userId }).toArray();

    if (enrollmentDocs.length === 0) {
      return res.json({ success: true, enrollments: [] });
    }

    const courseIds = enrollmentDocs
      .map((e) => { try { return new ObjectId(e.course); } catch { return null; } })
      .filter((id): id is ObjectId => id !== null);

    const courseDocs = await db.collection('courses').find({ _id: { $in: courseIds } }).toArray();
    const courseMap = new Map(courseDocs.map((c) => [c._id.toString(), c]));

    const enrollments = enrollmentDocs.map((d) => {
      const course = courseMap.get(d.course) || null;
      return {
        id: d._id.toString(),
        userId: d.student as string,
        courseId: d.course as string,
        progress: typeof d.progress === 'number' ? d.progress : 0,
        completedModules: Array.isArray(d.completedModules) ? d.completedModules : [],
        enrolledAt: d.enrolledAt,
        lastAccessed: d.lastAccessed,
        course: course ? {
          id: course._id.toString(),
          title: course.title,
          description: course.description,
          category: course.category,
          thumbnail: course.thumbnail,
          difficulty: course.difficulty ?? course.level ?? 'beginner',
          instructorName: course.instructorName ?? '',
          modules: Array.isArray(course.modules) ? course.modules : [],
        } : null,
      };
    });

    res.json({ success: true, enrollments });
  } catch (e) {
    console.error('listMyEnrollments', e);
    res.status(500).json({ success: false, message: 'Failed to load enrollments' });
  }
}

export async function getCourseEnrollments(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const db = getDB();

    if (!ObjectId.isValid(courseId)) {
      return res.status(400).json({ success: false, message: 'Invalid course ID' });
    }

    const course = await db.collection('courses').findOne({ _id: new ObjectId(courseId) });
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

    if (course.instructorId !== req.user!.id && req.user?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized to view course enrollments' });
    }

    const enrollmentDocs = await db.collection('enrollments').find({ course: courseId }).sort({ enrolledAt: -1 }).toArray();
    const studentIds = enrollmentDocs
      .map((e: any) => { try { return new ObjectId(e.student); } catch { return null; } })
      .filter((id): id is ObjectId => id !== null);

    const users = studentIds.length
      ? await db.collection('users').find({ _id: { $in: studentIds } }).toArray()
      : [];
    const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));

    const students = enrollmentDocs.map((d: any) => {
      const student = userMap.get(d.student);
      return {
        id: d._id.toString(),
        studentId: d.student,
        name: student?.name || student?.email || 'Unknown Student',
        email: student?.email || '',
        progress: typeof d.progress === 'number' ? d.progress : 0,
        completedModules: Array.isArray(d.completedModules) ? d.completedModules : [],
        enrolledAt: d.enrolledAt,
        lastAccessed: d.lastAccessed,
        status: d.status || 'active',
      };
    });

    res.json({ success: true, students });
  } catch (e) {
    console.error('getCourseEnrollments', e);
    res.status(500).json({ success: false, message: 'Failed to load course enrollments' });
  }
}

export async function enrollInCourse(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.body;

    if (!courseId) {
      return res.status(400).json({ success: false, message: 'courseId is required' });
    }

    const db = getDB();

    if (!ObjectId.isValid(courseId)) {
      return res.status(400).json({ success: false, message: 'Invalid course ID' });
    }

    const course = await db.collection('courses').findOne({ _id: new ObjectId(courseId) });
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    const userId = req.user!.id;

    const existing = await db.collection('enrollments').findOne({ student: userId, course: courseId });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Already enrolled in this course' });
    }

    const now = new Date();
    const doc = {
      student: userId,
      course: courseId,
      progress: 0,
      completedModules: [],
      status: 'active',
      enrolledAt: now,
      lastAccessed: now,
    };

    const result = await db.collection('enrollments').insertOne(doc);

    await db.collection('courses').updateOne(
      { _id: new ObjectId(courseId) },
      { $inc: { enrollmentCount: 1 } }
    );

    res.status(201).json({
      success: true,
      message: 'Enrolled successfully',
      enrollmentId: result.insertedId.toString()
    });
  } catch (e) {
    console.error('enrollInCourse', e);
    res.status(500).json({ success: false, message: 'Failed to enroll' });
  }
}

export async function unenrollFromCourse(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user!.id;

    const db = getDB();
    const result = await db.collection('enrollments').deleteOne({ student: userId, course: courseId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Enrollment not found' });
    }

    if (ObjectId.isValid(courseId)) {
      await db.collection('courses').updateOne(
        { _id: new ObjectId(courseId) },
        { $inc: { enrollmentCount: -1 } }
      );
    }

    res.json({ success: true, message: 'Unenrolled successfully' });
  } catch (e) {
    console.error('unenrollFromCourse', e);
    res.status(500).json({ success: false, message: 'Failed to unenroll' });
  }
}

export async function updateProgress(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const { moduleId, progress, completedModules } = req.body;
    const userId = req.user!.id;

    const db = getDB();
    const enrollment = await db.collection('enrollments').findOne({ student: userId, course: courseId });
    if (!enrollment) {
      return res.status(404).json({ success: false, message: 'Enrollment not found' });
    }

    const updates: Record<string, unknown> = { lastAccessed: new Date() };
    const prevList: string[] = Array.isArray(enrollment.completedModules)
      ? enrollment.completedModules.filter((x: unknown) => typeof x === 'string')
      : [];
    const prevSet = new Set(prevList);

    let course: { modules?: unknown[] } | null = null;
    if (ObjectId.isValid(courseId)) {
      course = (await db.collection('courses').findOne({ _id: new ObjectId(courseId) })) as { modules?: unknown[] } | null;
    }
    const validKeys = new Set(course ? lessonKeysFromCourse(course) : []);

    if (moduleId && typeof moduleId === 'string') {
      if (validKeys.size > 0 && !validKeys.has(moduleId)) {
        return res.status(400).json({ success: false, message: 'Invalid lesson id' });
      }
      if (!prevSet.has(moduleId)) {
        const ok = await db.collection('courseQuizAttempts').findOne({
          userId,
          courseId,
          lessonId: moduleId,
          passed: true,
        });
        if (!ok) {
          return res.status(403).json({
            success: false,
            message: 'Pass the lesson quiz before marking this lesson complete.',
          });
        }
      }
      if (typeof progress === 'number') updates.progress = Math.min(100, Math.max(0, progress));
      if (Array.isArray(completedModules)) {
        let incoming = completedModules.filter((x: unknown) => typeof x === 'string') as string[];
        if (validKeys.size > 0) incoming = incoming.filter((id) => validKeys.has(id));
        const filtered = await filterCompletedByPassedQuiz(db, userId, courseId, incoming, prevSet);
        updates.completedModules = filtered;
        const total = validKeys.size > 0 ? validKeys.size : Math.max(filtered.length, 1);
        updates.progress = Math.min(100, Math.max(0, Math.round((filtered.length / total) * 100)));
      }
      await db.collection('enrollments').updateOne(
        { student: userId, course: courseId },
        { $addToSet: { completedModules: moduleId }, $set: updates }
      );
      const fresh = await db.collection('enrollments').findOne({ student: userId, course: courseId });
      res.json({
        success: true,
        message: 'Progress updated',
        progress: typeof fresh?.progress === 'number' ? fresh.progress : 0,
        completedModules: Array.isArray(fresh?.completedModules)
          ? fresh.completedModules.filter((x: unknown) => typeof x === 'string')
          : [],
      });
      return;
    }

    if (Array.isArray(completedModules)) {
      let incoming = completedModules.filter((x: unknown) => typeof x === 'string') as string[];
      if (validKeys.size > 0) incoming = incoming.filter((id) => validKeys.has(id));
      const filtered = await filterCompletedByPassedQuiz(db, userId, courseId, incoming, prevSet);
      updates.completedModules = filtered;
      const totalLessons = validKeys.size > 0 ? validKeys.size : Math.max(filtered.length, 1);
      updates.progress = Math.min(100, Math.max(0, Math.round((filtered.length / totalLessons) * 100)));
    } else if (typeof progress === 'number') {
      updates.progress = Math.min(100, Math.max(0, progress));
    }

    await db.collection('enrollments').updateOne({ student: userId, course: courseId }, { $set: updates });
    const fresh = await db.collection('enrollments').findOne({ student: userId, course: courseId });
    res.json({
      success: true,
      message: 'Progress updated',
      progress: typeof fresh?.progress === 'number' ? fresh.progress : 0,
      completedModules: Array.isArray(fresh?.completedModules)
        ? fresh.completedModules.filter((x: unknown) => typeof x === 'string')
        : [],
    });
  } catch (e) {
    console.error('updateProgress', e);
    res.status(500).json({ success: false, message: 'Failed to update progress' });
  }
}

export async function checkEnrollment(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user!.id;

    const db = getDB();
    const enrollment = await db.collection('enrollments').findOne({ student: userId, course: courseId });

    res.json({ success: true, enrolled: Boolean(enrollment), enrollment: enrollment ? {
      id: enrollment._id.toString(),
      progress: enrollment.progress ?? 0,
      completedModules: enrollment.completedModules ?? [],
      enrolledAt: enrollment.enrolledAt,
    } : null });
  } catch (e) {
    console.error('checkEnrollment', e);
    res.status(500).json({ success: false, message: 'Failed to check enrollment' });
  }
}
