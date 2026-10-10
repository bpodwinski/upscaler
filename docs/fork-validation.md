# Validation du candidat

Le candidat `@ruxelion/upscaler@0.6.0-alpha.0` reste distinct d'une publication
npm. Aucun changement d'Exokosm n'est inclus. La contribution préparée pour
upstream reprend ce code avec les métadonnées upstream ; le fork conserve son
nom, sa version et ses workflows.

## Vérifications automatisées

La contribution préparée a passé 603 tests CPU dans 39 fichiers, lint, typecheck,
build du paquet et build de la galerie. La dernière répétition complète utilisait
deux workers, sans modifier les assertions ni les délais. Un premier passage sous
charge avait trois timeouts de fixtures de release et une erreur RPC Vitest ;
la répétition complète et les cas concernés ont ensuite réussi. Les deux relevés
sont conservés.

- CPU : descripteurs, dimensions impaires, ordre des étapes, uniforms distincts,
  reset/annulation, alias interdits, masques réactifs, variantes et jitter composé.
- Paquet : `npm run verify:packed-entrypoints` installe l'archive dans trois
  projets isolés ; `/core` fonctionne sans moteurs, `/babylon` sans Three,
  racine et `/three` sans Babylon. Imports runtime et compilation NodeNext
  stricte sont vérifiés. Les déclarations du cœur compilent sans `skipLibCheck`.
- Three : `verify:packed-guides:gpu` vérifie 16 frames scindées sur le paquet,
  deux textures d'historique et aucun fallback monolithique.
- WebGPU brut/Babylon : expositions indépendantes puis combinées, HDR/alpha finies,
  resize impair, NativeAA, optimisation d'alias activée/désactivée et parcours
  désactivé/réactivé. Le mode `verify:packed-core:gpu` utilise l'archive npm.
- Les fixtures de release configurent la signature dans chaque clone temporaire ;
  les réglages Git personnels restent inchangés.
- Les outils GPU vérifient leur profil de navigateur avant de créer une page et
  ferment leur navigateur par CDP. Les régressions avec un port occupé confirment
  que le navigateur préexistant reste ouvert.
- La comparaison baseline exige des ensembles de captures identiques ; un fichier
  manquant ou supplémentaire provoque une erreur.

## Matériel et contrôles fonctionnels

Les contrôles ont été exécutés sur RTX 5080 et RX 580 les 9 et 10 octobre 2026.
La RX 580 utilise Windows 11 Pro build 26200, Ryzen 5 2400G, pilote
31.0.21925.1001 et Chromium 153.0.8010.12 dans la session console active.
L'adaptateur WebGPU a identifié AMD / gcn-4 matériel. Les sources et serveurs
restaient sur le PC de développement ; seul le navigateur tournait à distance.

Les douze pages Babylon construites ont réussi sur les deux GPU : couleur,
profondeur, orientation, mouvements objets/caméra sans jitter, masques réactifs,
alpha, effets, guides partagés, dimensions impaires, NativeAA et alias on/off.
Le contrôle de mouvement caméra utilise des régions de l'image pour éviter la
dilution par le fond transparent : seuil absolu inchangé et signal supérieur à
dix fois le résidu de la scène immobile. Les captures ont été inspectées ; cela
reste une revue bornée, sans validation exhaustive des GPU mobiles.

Chaque instance du cœur et chaque tâche Babylon ont traversé 24 configurations
de taille/ratio. Deux effets hôtes s'exécutaient entre guides et upscale, avec une
couleur finale distincte. Une comparaison A/B avec reset vérifiait la consommation
de cette couleur ; la lecture GPU float32 vérifiait les deux expositions par frame.

Une perte contrôlée par `GPUDevice.destroy()` a vérifié `device.lost`,
l'invalidation des anciennes instances et le retour d'une sortie valide après
recréation. Babylon restaurait le même moteur avant recréation du graphe et de la
tâche ; son observable pouvait arriver avant la fin de l'initialisation WebGPU,
qui était attendue explicitement. Three refusait la préparation de l'ancienne
instance et fonctionnait après recréation par l'appelant. La restauration
automatique du renderer Three et un crash du pilote ne sont pas revendiqués.

Les captures Q0 RTX 5080, ratio 1.5, frames 8 et 32, correspondaient pixel pour
pixel à upstream. Les nouveaux relevés de convergence RGB et alpha Three ont
également reproduit exactement les métriques et traces upstream dans les fenêtres
mesurées. Cela ne remplace pas toute la matrice visuelle.

## Mesures de performance

Les répétitions du 10 octobre utilisaient huit blocs ABBA, 240 frames de chauffe
et 1200 échantillons par leg. L'acceptation ne retient que les legs avec profiling
bibliothèque désactivé et compare l'écart au bruit mesuré entre legs de même bras.
Les tests CPU du dépôt ont démarré après ces mesures.

| GPU / ratio | Écart temporel apparié | Bruit observé |
| --- | ---: | ---: |
| RX 580 / 1 | +0.02% | 0.90% |
| RX 580 / 1.5 | +1.87% | 4.89% |
| RX 580 / 2 | +1.50% | 3.31% |
| RX 580 / 3 | +1.54% | 3.10% |
| RTX 5080 / 1 | -2.42% | 11.46% |
| RTX 5080 / 1.5 | +0.15% | 9.87% |

Aucun écart n'a dépassé ce bruit. La variance RTX reste trop élevée pour exclure
une petite régression. Le signal RX 580 initial au ratio 2 (+2.35%, bruit 1.63%)
est conservé ; ses confirmations n'ont pas reproduit de régression supérieure au
bruit. Les échantillons anciens et nouveaux sont conservés. Ces mesures de débit
total/CPU synchronisées avec la queue ne sont pas des timings GPU isolés par passe.

## Conditions restant ouvertes

- Acceptation finale des performances à faible variance, avec profiling désactivé,
  échantillons enregistrés et seuil dérivé du bruit ; timings GPU isolés distincts.
- Revue visuelle humaine exhaustive : convergence, mouvement caméra/objets,
  transparence, HDR, NativeAA, presets et dimensions impaires.
- Perte liée au pilote/OS et récupération exhaustive propre à chaque application.
- Exécution de la CI GitHub distante sur le commit qui sera poussé.

Les rapports sont locaux sous `bench/results/windows-local/`,
`output/playwright/` et `artifacts/pr-preparation/`, ignorés par Git.
Les validations non exécutées ne sont pas déclarées réussies.
