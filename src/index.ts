import './load-env.js';
import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import authRoutes from './routes/auth.js';
import coursesRoutes from './routes/courses.js';
import enrollmentsRoutes from './routes/enrollments.js';
import caroaRoutes from './routes/caroa.js';
import aiRoutes from './routes/ai.js';
import assignmentsRoutes from './routes/assignments.js';
import certificatesRoutes from './routes/certificates.js';
import reviewsRoutes from './routes/reviews.js';
import notificationsRoutes from './routes/notifications.js';
import discussionsRoutes from './routes/discussions.js';
import liveClassesRoutes from './routes/liveClasses.js';
import analyticsRoutes from './routes/analytics.js';
import paymentsRoutes from './routes/payments.js';
import lessonFilesRoutes from './routes/lessonFiles.js';
import instructorInsightsRoutes from './routes/instructorInsights.js';
import interviewsRoutes from './routes/interviews.js';
import adminRoutes from './routes/admin.js';
import { connectDB } from './db/connection.js';

const app: Express = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: true,
  credentials: true
}));

// Serve uploaded files
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Request logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'OK', message: 'EDU-REV Backend is running', version: '2.0' });
});

// Short link from QR / emails → SPA verify page (human-readable)
const clientPublicUrl = process.env.CLIENT_URL || 'http://localhost:3000';
app.get('/verify/:certId', (req: Request, res: Response) => {
  const id = encodeURIComponent(req.params.certId);
  res.redirect(302, `${clientPublicUrl}/verify/${id}`);
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/courses', coursesRoutes);
app.use('/api/enrollments', enrollmentsRoutes);
app.use('/api/caroa', caroaRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/assignments', assignmentsRoutes);
app.use('/api/certificates', certificatesRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/discussions', discussionsRoutes);
app.use('/api/liveclasses', liveClassesRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/lesson-files', lessonFilesRoutes);
app.use('/api/instructor/insights', instructorInsightsRoutes);
app.use('/api/interviews', interviewsRoutes);
app.use('/api/admin', adminRoutes);

// Error handling
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

async function startServer() {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`🚀 EDU-REV Backend Server running on http://localhost:${PORT}`);
      console.log(`📝 Health check: http://localhost:${PORT}/health`);
      console.log(`🗄️  MongoDB connected and ready`);
      console.log(`🤖 Groq AI endpoints ready at /api/ai & /api/analytics`);
      console.log(`📚 All 14 LMS modules active`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

export default app;
