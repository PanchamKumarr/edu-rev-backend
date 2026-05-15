import { Response } from 'express';
import { ObjectId } from 'mongodb';
import path from 'path';
import fs from 'fs';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';

// ─── Upload file(s) for a lesson ─────────────────────────────────────────────
export async function uploadLessonFiles(req: AuthRequest, res: Response) {
  try {
    const { courseId, lessonId } = req.params;

    if (!req.files || (req.files as Express.Multer.File[]).length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded' });
    }

    if (!ObjectId.isValid(courseId)) {
      return res.status(400).json({ success: false, message: 'Invalid courseId' });
    }

    const db = getDB();
    const course = await db.collection('courses').findOne({ _id: new ObjectId(courseId) });
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

    if (course.instructorId !== req.user!.id && req.user!.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const uploadedFiles = (req.files as Express.Multer.File[]).map(file => ({
      originalName: file.originalname,
      filename: file.filename,
      mimetype: file.mimetype,
      size: file.size,
      url: `/uploads/lessons/${file.filename}`,
      uploadedAt: new Date(),
    }));

    // Update the lesson inside the course's modules array
    const modules = Array.isArray(course.modules) ? course.modules : [];
    let lessonFound = false;

    const updatedModules = modules.map((mod: any) => ({
      ...mod,
      lessons: (mod.lessons || []).map((les: any) => {
        if (les.id === lessonId) {
          lessonFound = true;
          return {
            ...les,
            files: [...(les.files || []), ...uploadedFiles],
          };
        }
        return les;
      }),
    }));

    if (!lessonFound) {
      // Clean up uploaded files
      (req.files as Express.Multer.File[]).forEach(f => {
        try { fs.unlinkSync(f.path); } catch { /* ignore */ }
      });
      return res.status(404).json({ success: false, message: 'Lesson not found in course' });
    }

    await db.collection('courses').updateOne(
      { _id: new ObjectId(courseId) },
      { $set: { modules: updatedModules, updatedAt: new Date() } }
    );

    res.json({ success: true, files: uploadedFiles, message: `${uploadedFiles.length} file(s) uploaded` });
  } catch (e) {
    console.error('uploadLessonFiles', e);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
}

// ─── Delete a lesson file ─────────────────────────────────────────────────────
export async function deleteLessonFile(req: AuthRequest, res: Response) {
  try {
    const { courseId, lessonId, filename } = req.params;

    if (!ObjectId.isValid(courseId)) return res.status(400).json({ success: false, message: 'Invalid courseId' });

    const db = getDB();
    const course = await db.collection('courses').findOne({ _id: new ObjectId(courseId) });
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

    if (course.instructorId !== req.user!.id && req.user!.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const modules = Array.isArray(course.modules) ? course.modules : [];
    const updatedModules = modules.map((mod: any) => ({
      ...mod,
      lessons: (mod.lessons || []).map((les: any) => {
        if (les.id === lessonId) {
          return { ...les, files: (les.files || []).filter((f: any) => f.filename !== filename) };
        }
        return les;
      }),
    }));

    await db.collection('courses').updateOne(
      { _id: new ObjectId(courseId) },
      { $set: { modules: updatedModules, updatedAt: new Date() } }
    );

    // Delete physical file
    const filePath = path.join(process.cwd(), 'uploads', 'lessons', filename);
    try { fs.unlinkSync(filePath); } catch { /* ignore if file not found */ }

    res.json({ success: true, message: 'File deleted' });
  } catch (e) {
    console.error('deleteLessonFile', e);
    res.status(500).json({ success: false, message: 'Failed to delete file' });
  }
}

// ─── Get lesson files ─────────────────────────────────────────────────────────
export async function getLessonFiles(req: AuthRequest, res: Response) {
  try {
    const { courseId, lessonId } = req.params;
    if (!ObjectId.isValid(courseId)) return res.status(400).json({ success: false, message: 'Invalid courseId' });

    const db = getDB();
    const course = await db.collection('courses').findOne({ _id: new ObjectId(courseId) });
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

    const modules = Array.isArray(course.modules) ? course.modules : [];
    let lessonFiles: any[] = [];

    for (const mod of modules) {
      for (const les of (mod.lessons || [])) {
        if (les.id === lessonId) {
          lessonFiles = les.files || [];
          break;
        }
      }
    }

    res.json({ success: true, files: lessonFiles });
  } catch (e) {
    console.error('getLessonFiles', e);
    res.status(500).json({ success: false, message: 'Failed to load files' });
  }
}
