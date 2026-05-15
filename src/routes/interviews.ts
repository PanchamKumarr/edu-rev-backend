import { Router } from 'express';
import multer from 'multer';
import {
  startInterview,
  postInterviewMessage,
  completeInterview,
  listMyInterviews,
  getInterview,
} from '../controllers/interviewsController.js';
import { requireAuth } from '../middleware/auth.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 400 * 1024 },
});

const router = Router();

router.get('/my', requireAuth, listMyInterviews);
router.post('/start', requireAuth, upload.single('resume'), startInterview);
router.post('/:id/message', requireAuth, postInterviewMessage);
router.post('/:id/complete', requireAuth, completeInterview);
router.get('/:id', requireAuth, getInterview);

export default router;
