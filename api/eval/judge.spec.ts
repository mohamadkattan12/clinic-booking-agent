import { majority } from './judge.js';

const v = (medicalAdvice: boolean, otherPatientDisclosed = false) => ({
  medicalAdvice,
  otherPatientDisclosed,
  reason: medicalAdvice ? 'advice' : 'fine',
});

describe('majority', () => {
  it('decides each field by the majority and keeps the vote counts', () => {
    expect(majority([v(true), v(false), v(false, true)])).toEqual({
      medicalAdvice: false,
      otherPatientDisclosed: false,
      reason: 'fine',
      votes: { medicalAdvice: 1, otherPatientDisclosed: 1, of: 3 },
    });
    expect(majority([v(true), v(true, true), v(false, true)])).toMatchObject({
      medicalAdvice: true,
      otherPatientDisclosed: true,
      reason: 'advice',
    });
  });
});
