import * as realApi from './client';
import * as mockApi from './mock';

const useMock = import.meta.env.VITE_USE_MOCK === 'true';
export const api = useMock ? mockApi : realApi;
