# NEXTecg Main Website

## Deployment Instructions

### Deploy to Vercel:

1. **Push to GitHub first**
2. **Deploy each app separately on Vercel:**

   - Deploy this main website
   - Deploy How My Heart app from `ecgx3/web/how-my-heart`
   - Deploy 6 Lead ECG app from `6-leadecg`

3. **After deployment, update environment variables:**
   
   In Vercel dashboard for this main website, add:
   ```
   VITE_SINGLE_LEAD_URL=https://your-single-lead.vercel.app
   VITE_SIX_LEAD_URL=https://your-six-lead.vercel.app
   ```

4. **Redeploy main website** after setting environment variables

## Local Development

```bash
npm install
npm run dev
```

Runs on http://localhost:3000
