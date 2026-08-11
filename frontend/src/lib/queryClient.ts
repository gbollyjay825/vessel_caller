import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => (
        !(error && typeof error === "object" && "status" in error && Number(error.status) < 500)
        && failureCount < 2
      ),
      refetchOnWindowFocus: true,
    },
  },
});

export function clearAuthenticatedQueryCache(): void {
  queryClient.clear();
}
