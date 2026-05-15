import { Db } from 'mongodb';

const SAMPLE_COURSES = [
  {
    title: 'Neural Foundations',
    description: 'Build intuition for deep learning architectures and optimization landscapes.',
    instructorId: 'system',
    instructor: 'system',
    price: 0,
    isFree: true,
    thumbnail: 'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?q=80&w=1200&auto=format&fit=crop',
    difficulty: 'intermediate' as const,
    level: 'intermediate' as const,
    rating: 4.8,
    reviewCount: 214,
    status: 'published' as const,
    modules: [
      {
        id: 'nf-m1',
        title: 'Activation Landscapes',
        content: '# Activation Landscapes\n\nExplore how non-linearities shape decision boundaries.',
        type: 'document' as const,
        order: 0
      },
      {
        id: 'nf-m2',
        title: 'Optimization Dynamics',
        content: '# Optimization\n\nGradient descent, momentum, and adaptive rates in practice.',
        type: 'document' as const,
        order: 1
      },
      {
        id: 'nf-m3',
        title: 'Lab: Training Loop',
        content: '## Lab\n\nImplement a minimal training loop and log loss curves.',
        type: 'video' as const,
        order: 2
      }
    ],
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    title: 'Data Engineering Studio',
    description: 'Pipelines, warehousing, and reliable ingestion for analytics workloads.',
    instructorId: 'system',
    instructor: 'system',
    price: 49,
    isFree: false,
    thumbnail: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?q=80&w=1200&auto=format&fit=crop',
    difficulty: 'advanced' as const,
    level: 'advanced' as const,
    rating: 4.6,
    reviewCount: 132,
    status: 'published' as const,
    modules: [
      {
        id: 'de-m1',
        title: 'Streaming Ingest',
        content: '# Streaming\n\nCompare Kafka, Pulsar, and cloud-native queues.',
        type: 'document' as const,
        order: 0
      },
      {
        id: 'de-m2',
        title: 'Dimensional Modeling',
        content: '# Star Schema\n\nFacts, dimensions, and slowly changing dimensions.',
        type: 'document' as const,
        order: 1
      }
    ],
    createdAt: new Date(),
    updatedAt: new Date()
  }
];

export async function seedCoursesIfEmpty(db: Db) {
  const col = db.collection('courses');
  const count = await col.countDocuments();
  if (count > 0) return;
  await col.insertMany(SAMPLE_COURSES);
  console.log('📚 Seeded sample courses');
}
