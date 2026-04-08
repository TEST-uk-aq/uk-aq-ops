FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY local/dashboard/server/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY local/dashboard/server/uk_aq_dashboard_local.py /app/local/dashboard/server/uk_aq_dashboard_local.py
COPY dashboard /app/dashboard

EXPOSE 8080

CMD ["sh", "-c", "python3 local/dashboard/server/uk_aq_dashboard_local.py --host 0.0.0.0 --port ${PORT:-8080} --html dashboard/index.html"]
