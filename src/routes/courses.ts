import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {
  listCourses,
  getCourse,
  createCourse,
  updateCourse,
  deleteCourse,
  getInstructorCourses,
} from '../controllers/coursesController.js';
import { postSyllabusMatch } from '../controllers/syllabusMatchController.js';
import { requireAuth } from '../middleware/auth.js';

const uploadsDir = path.join(process.cwd(), 'uploads', 'thumbnails');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `thumb-${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

const syllabusUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 },
});

const router = Router();

router.get('/', listCourses);
router.get('/my', requireAuth, getInstructorCourses);
router.post('/:id/syllabus-match', requireAuth, syllabusUpload.single('syllabus'), postSyllabusMatch);
router.get('/:id', getCourse);
router.post('/', requireAuth, upload.single('thumbnail'), createCourse);
router.put('/:id', requireAuth, upload.single('thumbnail'), updateCourse);
router.delete('/:id', requireAuth, deleteCourse);

export default router;
