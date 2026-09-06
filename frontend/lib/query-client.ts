"use client";

/**
 * TOWER TanStack Query provider (T-07) — TanStack Query v5, App Router pattern.
 *
 * Browser singleton (never re-created across suspends); a fresh client per
 * request on the server. T-08 consumes `['slots', date]` through this client
 * via `useRadarStream()`; T-07 consumes it for the parse mutation.
 */
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        /* Avoid instant refetch after hydration; radar polls on its own cadence. */
        staleTime: 30 * 1000,
        gcTime: 5 * 60 * 1000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

export function getQueryClient(): QueryClient {
  if (typeof window === "undefined") return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

/** Canonical query keys T-08 will use for the radar/gantt server state. */
export const slotKeys = {
  all: ["slots"] as const,
  byDate: (date: string) => ["slots", date] as const,
};

export function TowerQueryProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const queryClient = getQueryClient();
  /* createElement (not JSX): this file is .ts per the T-07 contract. */
  return React.createElement(QueryClientProvider, { client: queryClient }, children);
}
