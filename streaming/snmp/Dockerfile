FROM python:3.13-alpine

WORKDIR /app

COPY snmp/monitor.py /app/monitor.py

EXPOSE 9116

CMD ["python", "/app/monitor.py"]
