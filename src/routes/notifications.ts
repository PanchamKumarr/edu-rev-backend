import { Router } from 'express';
import { getNotifications, markRead, markAllRead, deleteNotification } from '../controllers/notificationsController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, getNotifications);
router.put('/read-all', requireAuth, markAllRead);
router.put('/:id/read', requireAuth, markRead);
router.delete('/:id', requireAuth, deleteNotification);

export default router;
