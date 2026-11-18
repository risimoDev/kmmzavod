import axios from 'axios';
import { config } from '../config';

export const internalHttp = axios.create({
  headers: config.INTERNAL_SERVICE_TOKEN ? { 'x-internal-token': config.INTERNAL_SERVICE_TOKEN } : undefined,
  maxRedirects: 0,
});
