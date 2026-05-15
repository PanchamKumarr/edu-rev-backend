import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { uploadLessonFiles, deleteLessonFile, getLessonFiles } from '../controllers/lessonFilesController.js';
import { requireAuth } from '../middleware/auth.js';

const lessonsDir = path.join(process.cwd(), 'uploads', 'lessons');
if (!fs.existsSync(lessonsDir)) fs.mkdirSync(lessonsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, lessonsDir),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv',
  'application/zip', 'application/x-zip-compressed',
];

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB per file
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} is not allowed`));
    }
  },
});

const router = Router();

router.get('/:courseId/lessons/:lessonId/files', requireAuth, getLessonFiles);
router.post('/:courseId/lessons/:lessonId/files', requireAuth, upload.array('files', 10), uploadLessonFiles);
router.delete('/:courseId/lessons/:lessonId/files/:filename', requireAuth, deleteLessonFile);

export default router;
