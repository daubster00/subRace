'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 25_000,
          retry: 3,
          throwOnError: false,
        },
      },
    })
  );
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
