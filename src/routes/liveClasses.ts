import { Router } from 'express';
import {
  scheduleLiveClass,
  getLiveClasses,
  getMyLiveClasses,
  markAttendance,
  rsvpLiveClass,
  updateLiveClass,
  deleteLiveClass,
} from '../controllers/liveClassesController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/my', requireAuth, getMyLiveClasses);
router.get('/', requireAuth, getLiveClasses);
router.post('/', requireAuth, scheduleLiveClass);
router.post('/:id/rsvp', requireAuth, rsvpLiveClass);
router.post('/:id/attend', requireAuth, markAttendance);
router.put('/:id', requireAuth, updateLiveClass);
router.delete('/:id', requireAuth, deleteLiveClass);

export default router;
