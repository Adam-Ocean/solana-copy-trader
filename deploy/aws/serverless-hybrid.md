# Serverless Hybrid Architecture

## What CAN Run as Functions:

### ✅ AWS Lambda Functions for:
1. **Trade Execution** - Triggered by SQS/SNS when signals arrive
2. **Price Alerts** - Scheduled checks every minute
3. **P&L Calculations** - On-demand calculations
4. **Database Writes** - Store trades in DynamoDB

### ❌ What MUST Run Continuously:
1. **WebSocket Listener** - Needs 24/7 connection to track wallet
2. **Dashboard** - Next.js app needs server

## Hybrid Architecture:

```
┌─────────────────────────────────────────┐
│         ECS Fargate (Always On)         │
│  - WebSocket Listener (minimal)         │
│  - Publishes to SNS on signals          │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│          SNS Topic (Signals)            │
└─────────────────────────────────────────┘
                    │
        ┌──────────┴──────────┐
        ▼                      ▼
┌──────────────┐      ┌──────────────┐
│ Lambda:      │      │ Lambda:      │
│ ExecuteTrade │      │ UpdatePnL    │
└──────────────┘      └──────────────┘
        │                      │
        ▼                      ▼
┌─────────────────────────────────────────┐
│         DynamoDB (Positions)            │
└─────────────────────────────────────────┘
```

## Cost Comparison (Monthly):

| Setup | Cost | Pros | Cons |
|-------|------|------|------|
| **EC2 t3.small** | ~$15 | Simple, full control | Always running |
| **Lambda + Fargate** | ~$25 | Auto-scaling, managed | More complex |
| **Just EC2 Spot** | ~$5 | Cheapest | Can be interrupted |

## Simplest Serverless: AWS App Runner

```yaml
# apprunner.yaml
version: 1.0
runtime: nodejs16
build:
  commands:
    build:
      - npm install
      - npm run build
run:
  runtime-version: 16
  command: node dist/index.js
  network:
    port: 4789
    env: PORT
  env:
    - name: NODE_ENV
      value: production
```

## Recommendation:

**For your use case (copy trading bot):**
1. **Development/Testing**: Simple EC2 with PM2 
2. **Production**: ECS Fargate or EC2 with auto-scaling
3. **NOT Recommended**: Pure Lambda (too many limitations)

The WebSocket connection and real-time requirements make traditional server deployment better than serverless for this application.