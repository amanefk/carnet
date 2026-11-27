# Carnet ESIEE

Site personnel pour centraliser les cours : semestres, matières, séances/chapitres avec suivi de progression, ressources (fichiers et liens), examens, accès importants et coffre d'identifiants chiffré.

- **Front** : HTML/CSS/JS sans build, hébergé gratuitement sur GitHub Pages.
- **Back** : Supabase (plan gratuit) pour la connexion, la base de données et le stockage des fichiers.
- **Coffre** : chiffré dans le navigateur (PBKDF2-SHA256 600 000 itérations, AES-256-GCM). Supabase ne stocke que du chiffré.

## Mise en ligne

### 1. Créer la base Supabase
1. Crée un compte sur https://supabase.com, puis **New project** (région *West EU (Paris)*). Note le mot de passe de base de données dans un endroit sûr.
2. **SQL Editor** > **New query** : colle le contenu de `supabase/schema.sql`, puis **Run**. Le message attendu est « Success. No rows returned ».
3. **Project Settings** > **API** : copie la *Project URL* et la clé *anon public* (ou *publishable*).
4. **Authentication** > **Sign In / Providers** > **Email** : désactive *Confirm email* si tu ne veux pas valider ton adresse par email (facultatif).

### 2. Relier le site à la base
Ouvre `js/config.js` et remplace les deux valeurs par celles copiées à l'étape 1.3.

> La clé anon est publique par conception. Ce qui protège tes données, ce sont les règles RLS du schéma : chaque ligne et chaque fichier n'est accessible qu'à son propriétaire connecté.

### 3. Publier sur GitHub Pages
1. Sur GitHub, crée un dépôt (par exemple `carnet`).
   - Dépôt **public** : fonctionne avec un compte gratuit. Le code est visible, mais il ne contient aucun secret.
   - Dépôt **privé** : nécessite GitHub Pro, gratuit avec le GitHub Student Developer Pack (mail ESIEE).
2. Envoie tous les fichiers du dossier (bouton **Add file** > **Upload files**, ou `git push`). Le fichier `.nojekyll` doit être inclus.
3. **Settings** > **Pages** > *Source* : **Deploy from a branch**, branche `main`, dossier `/ (root)`.
4. Après une à deux minutes, le site est disponible sur `https://<ton-pseudo>.github.io/carnet/`.
5. Dans Supabase, **Authentication** > **URL Configuration** > *Site URL* : colle cette adresse.

### 4. Créer ton compte puis fermer les inscriptions
1. Ouvre le site, choisis **Première visite : créer le compte**.
2. **Important** : dans Supabase, **Authentication** > **Sign In / Providers**, désactive **Allow new users to sign up**. Sans ça, n'importe qui pourrait se créer un compte sur ta base. Il ne verrait pas tes données, mais consommerait ton quota.

### 5. Importer le syllabus
**Réglages** > **Importer un syllabus** : colle un JSON au format de `data/exemple-import.json`. Les clés `units` acceptent un simple titre ou un objet `{ "kind", "title", "date" }`. Les examens se rattachent à une matière via `subject_code`.

## Utilisation
- **Progression** : chaque séance ou chapitre a un état (*À voir*, *En cours*, *À revoir*, *Maîtrisé*) et un niveau de confiance de 1 à 5. Le pourcentage d'une matière pondère les états : 0, 40, 70 et 100 %.
- **Bande de progression** : sur la page d'une matière, cliquer sur une case fait passer l'état au suivant.
- **Ressources** : glisser-déposer des fichiers (50 Mo max chacun) ou ajouter des liens (Google Docs, Moodle…). Une ressource peut être rattachée à une séance précise.
- **Examens** : compte à rebours, notes, moyenne pondérée, export `.ics` pour Google Agenda ou Outlook (rappel 2 jours avant).
- **Coffre** : verrouillage automatique après 5 minutes d'inactivité, et le presse-papiers est vidé 30 s après la copie d'un mot de passe. **Un mot de passe maître oublié rend le coffre irrécupérable.**
- **Sauvegarde** : Réglages > Télécharger la sauvegarde (structure, progression, examens, accès ; sans les fichiers ni le coffre).

## Limites du plan gratuit Supabase
- 500 Mo de base de données et 1 Go de stockage de fichiers.
- 50 Mo maximum par fichier.
- Un projet inactif pendant 7 jours est mis en pause. Les données sont conservées ; il suffit de cliquer sur **Restore** dans le tableau de bord Supabase.

## Structure
```
index.html
css/style.css
js/app.js        interface, navigation, données
js/vault.js      chiffrement du coffre
js/config.js     URL et clé Supabase
supabase/schema.sql
data/exemple-import.json
```

## Sécurité
- **Code public, données privées** : le dépôt ne contient aucun secret. La clé Supabase du site est publique par conception ; l'accès aux données est contrôlé par les règles RLS (chaque ligne et chaque fichier n'est lisible que par son propriétaire connecté).
- **Double authentification (TOTP)** : à activer dans Réglages. Une fois activée, la base refuse toute requête d'une session qui n'a pas saisi le code.
- **Coffre** : chiffré dans le navigateur (AES-256-GCM, clé dérivée du mot de passe maître par PBKDF2-SHA256, 600 000 itérations). Supabase ne stocke que du chiffré.
- **Politique de sécurité du contenu (CSP)** : seuls les scripts hébergés avec le site s'exécutent, et le navigateur ne peut contacter que Supabase. La bibliothèque Supabase est copiée dans `js/vendor/` (version figée) au lieu d'être chargée depuis un CDN.
- **Inscriptions fermées** dans Supabase (Authentication > Sign In / Providers).
- **À protéger hors du site** : comptes GitHub, Supabase et la messagerie liée au compte, chacun avec sa propre double authentification.
- **Révision (quiz et flashcards)** : générée par l'API Mistral (offre gratuite, entraînement sur les données désactivé dans le compte Mistral) via la fonction Supabase `quiz`. Secret à définir : `MISTRAL_API_KEY`.
