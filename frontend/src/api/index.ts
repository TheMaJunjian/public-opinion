import * as realApi from './client';
import * as mockApi from './mock';

const useMock = import.meta.env.VITE_USE_MOCK === 'true' || import.meta.env.DEV === false;
export const api = useMock ? mockApi : realApi;
