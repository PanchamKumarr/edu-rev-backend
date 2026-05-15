import { Router } from 'express';
import {
  getDiscussions,
  createDiscussion,
  addReply,
  likeDiscussion,
  deleteDiscussion,
  summarizeDiscussions,
} from '../controllers/discussionsController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.post('/:courseId/summary', requireAuth, summarizeDiscussions);
router.get('/:courseId', requireAuth, getDiscussions);
router.post('/:courseId', requireAuth, createDiscussion);
router.post('/reply/:discussionId', requireAuth, addReply);
router.put('/like/:discussionId', requireAuth, likeDiscussion);
router.delete('/:discussionId', requireAuth, deleteDiscussion);

export default router;
