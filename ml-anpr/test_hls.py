import cv2

url = "https://levy-selections-tags-agents.trycloudflare.com/stream/16/index.m3u8"
cap = cv2.VideoCapture(url)

if not cap.isOpened():
    print("Failed to open")
else:
    print("Connected! Reading frames...")
    for i in range(5):
        ret, frame = cap.read()
        print(f"Frame {i}: {'ok, shape=' + str(frame.shape) if ret else 'failed'}")
    cap.release()