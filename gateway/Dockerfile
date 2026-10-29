# The live-screen gateway: checks the plugin's short-lived tickets and pipes the computer's
# screencast to people's browsers, shared between viewers, with the computer's token added here.
FROM oven/bun:1.4.3-slim
WORKDIR /app
COPY gateway.ts ./
# 4200: the live screen (route it from outside). 4201: for the plugin only (keep it internal).
ENV PORT=4200 INTERNAL_PORT=4201 COMPUTER_URL=http://agent-computer:4100 NODE_ENV=production
EXPOSE 4200 4201
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||4200)+'/_computer/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER bun
CMD ["bun", "run", "gateway.ts"]
