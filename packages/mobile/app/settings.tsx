import React, { useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../lib/colors";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import Constants from "expo-constants";

const BASE_URL =
  (Constants.expoConfig?.extra?.apiUrl as string) ??
  process.env.EXPO_PUBLIC_API_URL ??
  "http://localhost:4200/";

export default function SettingsScreen() {
  const router = useRouter();
  const qc = useQueryClient();

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await api.settings.$get();
      return res.json() as any;
    },
  });

  const { data: portfolioData } = useQuery({
    queryKey: ["portfolio-kalshi"],
    queryFn: async () => {
      const res = await api.portfolio.$get();
      return res.json() as any;
    },
  });

  const s = settingsData?.settings || {};
  const kalshiConnected = portfolioData?.connected === true;
  const balance = portfolioData?.balance?.balance ?? null;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      {/* Nav */}
      <View style={styles.nav}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={16} color={Colors.blue} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.navTitle}>Settings</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>

        {/* Connection status */}
        <View style={[styles.statusCard, kalshiConnected && styles.statusCardConnected]}>
          <View style={[styles.statusDot, { backgroundColor: kalshiConnected ? Colors.green : Colors.gray }]} />
          <View style={{ marginLeft: 12, flex: 1 }}>
            <Text style={styles.statusTitle}>
              {kalshiConnected ? "Kalshi Connected" : "Connecting to Kalshi..."}
            </Text>
            <Text style={styles.statusSub}>
              {kalshiConnected
                ? `Live trading active${balance != null ? ` · $${balance.toFixed(2)} balance` : ""}`
                : "Establishing connection to your Kalshi account"}
            </Text>
          </View>
          {kalshiConnected && (
            <View style={styles.liveTag}>
              <Text style={styles.liveTagText}>LIVE</Text>
            </View>
          )}
        </View>

        {/* Info */}
        <View style={styles.infoCard}>
          <Text style={styles.infoCardTitle}>Auto-Connected</Text>
          <Text style={styles.infoCardText}>
            PulseTrade connects to your Kalshi account automatically using your secure API key. Market data refreshes every 5 seconds. No manual login required.
          </Text>
        </View>

        {/* Quick links */}
        <Text style={styles.sectionLabel}>NAVIGATION</Text>
        <View style={styles.linksCard}>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => router.push("/auto-trade" as any)}
            activeOpacity={0.8}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="flash-outline" size={18} color={Colors.purple} />
              <Text style={styles.linkText}>Auto-Trade Settings</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={Colors.gray} />
          </TouchableOpacity>
          <View style={styles.linkDivider} />
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => router.push("/portfolio" as any)}
            activeOpacity={0.8}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="briefcase-outline" size={18} color={Colors.blue} />
              <Text style={styles.linkText}>Portfolio & Positions</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={Colors.gray} />
          </TouchableOpacity>
          <View style={styles.linkDivider} />
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => router.push("/diagnostics" as any)}
            activeOpacity={0.8}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="pulse-outline" size={18} color={Colors.gray} />
              <Text style={styles.linkText}>System Diagnostics</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={Colors.gray} />
          </TouchableOpacity>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  nav: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 12,
  },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 2 },
  backText: { fontSize: 15, color: Colors.blue, fontWeight: "500" },
  navTitle: { fontSize: 17, fontWeight: "600", color: Colors.white },

  statusCard: {
    flexDirection: "row", alignItems: "center",
    marginHorizontal: 16, marginBottom: 16,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
    padding: 16,
  },
  statusCardConnected: {
    borderColor: "rgba(34,197,94,0.25)",
    backgroundColor: "rgba(34,197,94,0.05)",
  },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusTitle: { fontSize: 14, fontWeight: "600", color: Colors.white, marginBottom: 2 },
  statusSub: { fontSize: 12, color: Colors.gray, lineHeight: 17 },
  liveTag: {
    backgroundColor: "rgba(34,197,94,0.15)", borderRadius: 6,
    borderWidth: 1, borderColor: "rgba(34,197,94,0.3)",
    paddingHorizontal: 8, paddingVertical: 3,
  },
  liveTagText: { fontSize: 10, color: Colors.green, fontWeight: "700", letterSpacing: 0.8 },

  sectionLabel: {
    fontSize: 11, color: Colors.gray, fontWeight: "600",
    paddingHorizontal: 16, marginBottom: 8, letterSpacing: 0.8,
  },

  infoCard: {
    marginHorizontal: 16, marginBottom: 20,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
    padding: 16,
  },
  infoCardTitle: { fontSize: 14, fontWeight: "700", color: Colors.white, marginBottom: 8 },
  infoCardText: { fontSize: 13, color: Colors.gray, lineHeight: 20 },

  linksCard: {
    marginHorizontal: 16, marginBottom: 16,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border, overflow: "hidden",
  },
  linkRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    padding: 16,
  },
  linkLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  linkText: { fontSize: 14, fontWeight: "500", color: Colors.white },
  linkDivider: { height: 1, backgroundColor: Colors.border },
});
