import { Router } from 'express';
import { getCaroaContext, postActivity, postMastery } from '../controllers/caroaController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/context', requireAuth, getCaroaContext);
router.post('/mastery', requireAuth, postMastery);
router.post('/activity', requireAuth, postActivity);

export default router;
