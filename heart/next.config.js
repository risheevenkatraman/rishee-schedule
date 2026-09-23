import { fileURLToPath } from 'node:url';

const nextConfig = {
  output: 'export',
  poweredByHeader: false,
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
};

export default nextConfig;
