import { Router } from 'express';
import {
  generateMCQ,
  chatWithAI,
  saveMCQAttempt,
  listMCQAttempts,
  getMCQAttempt,
  generateCareerRoadmap,
} from '../controllers/aiController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.post('/generate-mcq', requireAuth, generateMCQ);
router.get('/mcq-attempts', requireAuth, listMCQAttempts);
router.get('/mcq-attempts/:id', requireAuth, getMCQAttempt);
router.post('/mcq-attempts', requireAuth, saveMCQAttempt);
router.post('/chat', requireAuth, chatWithAI);
router.post('/career-roadmap', requireAuth, generateCareerRoadmap);

export default router;
