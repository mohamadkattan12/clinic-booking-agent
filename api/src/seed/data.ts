// Fictional demo clinic. Names, phone numbers and prices are made up.

const h = (hour: number, min = 0) => hour * 60 + min;
const SAR = (riyals: number) => riyals * 100;

// 0 = Sunday ... 6 = Saturday. Closed on Friday (5).
export const CLINIC_HOURS = [0, 1, 2, 3, 4, 6].map((weekday) => ({
  weekday,
  startMinute: h(9),
  endMinute: h(21),
}));

export const SERVICES = [
  {
    id: 'checkup',
    nameAr: 'فحص عام',
    nameEn: 'Check-up',
    durationMin: 20,
    priceHalalas: SAR(150),
    prepAr: 'لا يلزم تحضير.',
    prepEn: 'No preparation needed.',
  },
  {
    id: 'cleaning',
    nameAr: 'تنظيف الأسنان',
    nameEn: 'Teeth cleaning',
    durationMin: 30,
    priceHalalas: SAR(250),
    prepAr: 'نظّف أسنانك بالفرشاة قبل الموعد.',
    prepEn: 'Brush your teeth before the visit.',
  },
  {
    id: 'filling',
    nameAr: 'حشوة',
    nameEn: 'Filling',
    durationMin: 45,
    priceHalalas: SAR(450),
    prepAr: 'تناول وجبة خفيفة قبل الموعد بساعتين.',
    prepEn: 'Have a light meal two hours before.',
  },
  {
    id: 'whitening',
    nameAr: 'تبييض الأسنان',
    nameEn: 'Teeth whitening',
    durationMin: 60,
    priceHalalas: SAR(1200),
    prepAr: 'تجنب القهوة والشاي قبل الموعد بيوم.',
    prepEn: 'Avoid coffee and tea the day before.',
  },
  {
    id: 'root-canal',
    nameAr: 'علاج العصب',
    nameEn: 'Root canal treatment',
    durationMin: 90,
    priceHalalas: SAR(1800),
    prepAr: 'أحضر أي أشعة سابقة إن وجدت.',
    prepEn: 'Bring any previous X-rays if you have them.',
  },
  {
    id: 'extraction',
    nameAr: 'خلع سن',
    nameEn: 'Tooth extraction',
    durationMin: 30,
    priceHalalas: SAR(350),
    prepAr: 'تناول وجبة قبل الموعد ورتّب من يوصلك.',
    prepEn: 'Eat before the visit and arrange a ride home.',
  },
  {
    id: 'ortho-consult',
    nameAr: 'استشارة تقويم',
    nameEn: 'Braces consultation',
    durationMin: 30,
    priceHalalas: SAR(200),
    prepAr: 'لا يلزم تحضير.',
    prepEn: 'No preparation needed.',
  },
];

export const DENTISTS = [
  {
    id: 'dr-sara',
    nameAr: 'د. سارة القحطاني',
    nameEn: 'Dr. Sara Al-Qahtani',
    services: ['checkup', 'cleaning', 'filling', 'whitening'],
    schedule: [0, 1, 2, 3, 4].map((weekday) => ({
      weekday,
      startMinute: h(9),
      endMinute: h(17),
    })),
  },
  {
    id: 'dr-omar',
    nameAr: 'د. عمر الحربي',
    nameEn: 'Dr. Omar Al-Harbi',
    services: ['checkup', 'filling', 'root-canal', 'extraction'],
    schedule: [6, 0, 1, 2, 3].map((weekday) => ({
      weekday,
      startMinute: h(13),
      endMinute: h(21),
    })),
  },
  {
    id: 'dr-lina',
    nameAr: 'د. لينا حداد',
    nameEn: 'Dr. Lina Haddad',
    services: ['checkup', 'cleaning', 'ortho-consult'],
    schedule: [6, 1, 3].map((weekday) => ({
      weekday,
      startMinute: h(10),
      endMinute: h(18),
    })),
  },
];

export const PATIENTS = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    phone: '+966500000001',
    name: 'نورة العتيبي',
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    phone: '+966500000002',
    name: 'Khalid Al-Shehri',
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    phone: '+966500000003',
    name: 'ريم السبيعي',
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    phone: '+966500000004',
    name: 'Fahad Al-Dosari',
  },
];

/** Existing bookings, placed relative to the seed time: [patient, dentist, service, weekday, minute, weeks ahead]. */
export const EXISTING_APPOINTMENTS: [
  string,
  string,
  string,
  number,
  number,
  number,
][] = [
  [PATIENTS[0].id, 'dr-sara', 'cleaning', 1, h(10), 1],
  [PATIENTS[1].id, 'dr-omar', 'root-canal', 2, h(14), 1],
  [PATIENTS[1].id, 'dr-sara', 'checkup', 3, h(11), 2],
  [PATIENTS[3].id, 'dr-lina', 'ortho-consult', 6, h(12), 1],
];
