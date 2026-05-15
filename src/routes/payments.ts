import { Router } from 'express';
import { createOrder, completeOrder, getMyOrders } from '../controllers/paymentsController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/orders', requireAuth, getMyOrders);
router.post('/orders', requireAuth, createOrder);
router.post('/orders/:orderId/complete', requireAuth, completeOrder);

export default router;
