import { Router } from 'express';
import { addReview, getCourseReviews, deleteReview, summarizeCourseReviews } from '../controllers/reviewsController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.post('/:courseId/summary', requireAuth, summarizeCourseReviews);
router.get('/:courseId', getCourseReviews);
router.post('/:courseId', requireAuth, addReview);
router.delete('/:courseId', requireAuth, deleteReview);

export default router;
