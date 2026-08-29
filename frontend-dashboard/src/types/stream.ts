export interface CameraFeed {
  id: string;
  name: string;
  department: string;
  location: string;
  hlsUrl: string;
  status: "ONLINE" | "OFFLINE" | "DEGRADED";
}