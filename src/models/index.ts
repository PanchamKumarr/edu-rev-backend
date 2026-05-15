// Database Models and Types for EDU-REV

/** Optional learner context — used for CAROA recommendations and analytics summaries. */
export interface IInsightsProfile {
  careerOrStudyGoal?: string;
  weeklyStudyHours?: string;
  subjectsOfInterest?: string;
  learningChallenges?: string;
  preferredFormats?: string;
}

export interface IUser {
  _id?: string;
  email: string;
  password: string;
  name: string;
  role: 'student' | 'instructor' | 'admin';
  displayName?: string;
  profileImage?: string;
  bio?: string;
  phone?: string;
  /** Saved from Settings — informs AI analytics and recommendations. */
  insightsProfile?: IInsightsProfile;
  isActive: boolean;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLogin?: Date;
}

export interface ICourse {
  _id?: string;
  title: string;
  description: string;
  instructor: string; // User ID
  category: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  price: number;
  isFree: boolean;
  thumbnail?: string;
  modules: IModule[];
  enrollmentCount: number;
  rating: number;
  reviewCount: number;
  duration: number; // in hours
  language: string;
  status: 'draft' | 'published' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}

export interface IModule {
  _id?: string;
  title: string;
  description: string;
  lessons: ILesson[];
  order: number;
}

export interface ILesson {
  _id?: string;
  title: string;
  description: string;
  videoUrl?: string;
  duration: number; // in minutes
  content?: string;
  attachments?: string[];
  order: number;
}

export interface IEnrollment {
  _id?: string;
  student: string; // User ID
  course: string; // Course ID
  enrollmentDate: Date;
  status: 'active' | 'completed' | 'dropped';
  progress: number; // percentage 0-100
  completedLessons: string[]; // Lesson IDs
  certificateId?: string;
}

export interface IAssignment {
  _id?: string;
  title: string;
  description: string;
  course: string; // Course ID
  dueDate: Date;
  totalPoints: number;
  questions: IQuestion[];
  createdBy: string; // Instructor ID
  createdAt: Date;
}

export interface IQuestion {
  _id?: string;
  type: 'mcq' | 'subjective';
  text: string;
  points: number;
  options?: string[]; // For MCQ
  correctAnswer?: string; // For MCQ
  rubric?: string; // For subjective
}

export interface ISubmission {
  _id?: string;
  assignment: string; // Assignment ID
  student: string; // Student ID
  answers: IAnswer[];
  submittedAt: Date;
  score?: number;
  feedback?: string;
  status: 'submitted' | 'graded';
}

export interface IAnswer {
  questionId: string;
  answer: string;
  points?: number;
}

export interface ICertificate {
  _id?: string;
  enrollmentId: string; // Enrollment ID
  certId: string; // Unique certificate ID
  issuedDate: Date;
  course: string;
  student: string;
  qrCode?: string;
  isVerified: boolean;
}

export interface IPayment {
  _id?: string;
  student: string; // Student ID
  course: string; // Course ID
  amount: number;
  currency: string;
  paymentMethod: string;
  transactionId: string;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  createdAt: Date;
  completedAt?: Date;
}

export interface IAnalytics {
  _id?: string;
  userId: string;
  course: string;
  timeSpent: number; // in minutes
  quizAttempts: number;
  averageScore: number;
  lastAccessed: Date;
  engagementScore: number;
  masteryLevel: Record<string, number>; // topic -> mastery level (0-1)
}

export interface ICAROAProfile {
  _id?: string;
  userId: string;
  learningStyle: string;
  strengths: string[];
  weaknesses: string[];
  recommendedCourses: string[]; // Course IDs
  recommendedTopics: string[];
  riskLevel: 'low' | 'medium' | 'high';
  lastUpdated: Date;
}
