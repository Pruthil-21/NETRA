import { CameraFeed } from "@/types/stream";

const DEFAULT_STREAM = process.env.NEXT_PUBLIC_DEFAULT_HLS_URL || "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

export const MOCK_FEEDS: CameraFeed[] = [
  {
    id: "CAM-01",
    name: "Ahmedabad Highway Junction",
    department: "Traffic Police",
    location: "Sector 1, Gandhinagar",
    hlsUrl: DEFAULT_STREAM,
    status: "ONLINE",
  },
  {
    id: "CAM-02",
    name: "Surat City Checkpost East",
    department: "Home Department",
    location: "Varachha Main Rd",
    hlsUrl: DEFAULT_STREAM,
    status: "ONLINE",
  },
  {
    id: "CAM-03",
    name: "Vadodara Express Terminal",
    department: "Transport (SST)",
    location: "Central Bus Depot",
    hlsUrl: DEFAULT_STREAM,
    status: "ONLINE",
  },
];
