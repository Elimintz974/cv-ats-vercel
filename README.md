# CV-ATS

Diagnostic de compatibilité ATS et réécriture de CV. Next.js 15 (App Router), déployable sur Vercel.

---

## Déployer en 6 étapes

### 1. Récupérer une clé API

Sur [platform.claude.com](https://platform.claude.com) : crée un compte, ajoute du crédit, génère une clé (`sk-ant-...`).
C'est **ta** clé, et **toi** qui paies chaque requête. Voir « Coût » plus bas.

### 2. Tester en local

```bash
npm install
cp .env.example .env.local     # puis colle ta clé dedans
npm run dev                    # http://localhost:3000
```

`.env.local` est déjà dans `.gitignore`. Ne le commite jamais.

### 3. Mettre sur GitHub

```bash
git init
git add .
git commit -m "CV-ATS"
git branch -M main
git remote add origin https://github.com/TON-COMPTE/cv-ats.git
git push -u origin main
```

### 4. Importer dans Vercel

[vercel.com/new](https://vercel.com/new) → *Import Git Repository* → choisis le dépôt.
Next.js est détecté automatiquement, ne touche à rien dans les réglages de build.

### 5. Ajouter la clé — l'étape à ne pas rater

Avant de cliquer sur *Deploy* : section **Environment Variables**

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` |

Coche les trois environnements (Production, Preview, Development).

> Si tu ajoutes la variable **après** un déploiement, il faut redéployer pour qu'elle soit prise en compte (Deployments → ⋯ → Redeploy).

### 6. Déployer

Tu obtiens une URL en `.vercel.app`. Chaque `git push` redéploie tout seul.

---

## Ce qu'il faut savoir avant d'ouvrir l'URL à tout le monde

**Ta clé paie pour tout le monde.** N'importe qui avec le lien consomme ton crédit. C'est pour ça que :

- les prompts sont **côté serveur** (`app/api/analyze/route.js`) : personne ne peut détourner ta clé pour faire autre chose qu'analyser un CV ;
- une limitation à **12 requêtes/heure/IP** est en place. Elle est *best effort* : la mémoire n'est pas partagée entre les instances serverless de Vercel, donc elle freine sans bloquer. Pour du solide, branche [Upstash Redis](https://upstash.com) (offre gratuite, intégration Vercel en un clic) et remplace la fonction `rateLimited`.

**Mets un plafond de dépense** dans la console Claude (Settings → Limits). C'est le seul garde-fou vraiment fiable.

**Le plan Hobby de Vercel est réservé à un usage personnel non commercial**, et plafonne les fonctions à 60 secondes. C'est pris en compte : `maxDuration = 60` et un budget interne de 48 s dans la route.

---

## Coût

Le modèle utilisé est `claude-sonnet-5` — <cite index="8-1">2 $ par million de tokens en entrée, 10 $ par million en sortie</cite>.

En pratique : un CV + une annonce ≈ 2 000 tokens en entrée, une réécriture ≈ 1 500 en sortie. Soit environ **0,02 $ par optimisation**, moins pour un scan. Une centaine d'utilisations coûte quelques euros.

Pour diviser le coût par deux, remplace `MODEL` par `claude-haiku-4-5` dans la route — au prix d'une réécriture un peu moins fine.

---

## Structure

```
app/
  page.js              interface (client) — lecture de fichier, surlignage, affichage
  layout.js            structure HTML
  globals.css          styles
  api/analyze/route.js appel du modèle — la clé ne quitte jamais le serveur
```

**Point important :** le CV n'est jamais stocké. Il transite par la fonction serverless le temps de la requête, rien n'est écrit nulle part. Si tu veux le dire aux utilisateurs, c'est vrai.

### Les deux pièges déjà traités

1. **Réponse coupée.** Un CV complet peut dépasser la longueur maximale d'une réponse. La route détecte `stop_reason: "max_tokens"` et relance le modèle exactement au point d'arrêt (jusqu'à 3 tours, dans la limite du temps disponible). Sans ça, tu sers des CV tronqués en plein milieu d'une phrase — c'est le bug le plus fréquent sur ce type d'outil.
2. **JSON invalide.** Le scan renvoie du JSON. Le parseur retire les balises de code, isole l'objet, et chaque champ est validé côté client avant affichage. Une réponse malformée donne un message clair, jamais un écran blanc.

---

## Personnaliser

- **Ton des prompts, sections du CV, critères du scan** : `app/api/analyze/route.js`, constantes `SYS_SCAN` et `SYS_OPT`.
- **Couleurs et typo** : variables CSS en haut de `app/globals.css`.
- **Export `.docx`** au lieu de `.txt` : ajoute `docx` (npm) et génère le fichier côté client. Le `.txt` reste le format le plus sûr pour un ATS.

---

## Vérifié

`npm install` et `npm run build` passent (Next 15.5). Les cas d'erreur de la route ont été testés : mode invalide, CV vide, optimisation sans annonce, corps illisible, clé refusée — chacun renvoie un message lisible avec le bon code HTTP.

**Pas testé faute de clé et de navigateur ici :** une génération réussie de bout en bout, et l'import `.docx` / `.pdf`. Lance-les une fois en local avant de pousser en production.
