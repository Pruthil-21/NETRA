# Backend Watchlist

API and logic tying the alerting pipeline together: stores the watchlist (flagged plates), receives plate detections from `ml-anpr/`, checks for matches, and creates alerts consumed by `frontend-map/`.
