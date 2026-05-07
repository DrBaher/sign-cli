# Production onboarding bundle

This bundle gets a new operator from "no clone yet" to "first real signed PDF" without surprises.

## 0. Pick a provider
See [PROVIDER_SELECTION.md](./PROVIDER_SELECTION.md). Run `node dist/cli.js doctor providers`
after configuring your `.env` to see a machine-readable matrix of provider capabilities and config
gaps.

## 1. Clone, install, build
```bash
git clone https://github.com/DrBaher/cli-digital-signature-mvp.git
cd cli-digital-signature-mvp
npm install
cp .env.example .env
npm run build
```

## 2. Fill in `.env`
Open `.env` and only fill the section for the provider you chose. Other sections can stay blank
without breaking unrelated commands (the matrix output will show them as not configured).

## 3. Run the setup checklist
See [CHECKLIST.md](./CHECKLIST.md). It's the same flow for every provider, only the provider
name changes.

## 4. First signed document
Pick the snippet that matches your provider in the README:
- Dropbox Sign — README "Standard user journey"
- DocuSign — README "DocuSign setup"
- SignWell — README "SignWell setup" (or [SIGNWELL_SETUP.md](./SIGNWELL_SETUP.md))

## 5. When something breaks
See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
