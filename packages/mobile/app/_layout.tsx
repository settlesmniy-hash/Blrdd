import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusBar } from "expo-status-bar";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { Colors } from "../lib/colors";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5000, refetchInterval: 5000 },
  },
});

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: Colors.bg },
              animation: "slide_from_right",
            }}
          >
            <Stack.Screen name="index" />
            <Stack.Screen name="portfolio" />
            <Stack.Screen name="performance" />
            <Stack.Screen name="settings" />
            <Stack.Screen name="market/[ticker]" />
            <Stack.Screen name="diagnostics" />
          </Stack>
        </QueryClientProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
