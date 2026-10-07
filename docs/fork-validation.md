# Validation du candidat

Le candidat reste distinct d'une publication npm. Aucun changement d'Exokosm n'est inclus.

## Vérifications automatisées

- Suite locale : 37 fichiers, 588 tests réussis ; lint, typecheck, build du paquet et build des exemples réussis.
- CPU : descripteurs, dimensions impaires, ordre des étapes, uniforms distincts, reset/annulation, alias interdits et masque réactif partagé, variantes et jitter composé.
- Paquet : npm run verify:packed-entrypoints installe l'archive dans trois projets temporaires ; /core fonctionne sans moteurs, /babylon sans Three et racine + /three sans Babylon. Imports runtime et compilation NodeNext du consommateur sont vérifiés. /core vérifie également ses déclarations sans skipLibCheck avec TS 5.7.
- Three : npm run verify:packed-guides:gpu exécute le consommateur des guides scindés sur le paquet. L'extraction a passé 16 frames scindées avec deux textures d'historique et aucun fallback monolithique.
- GPU brut/Babylon : npm run verify:core:gpu vérifie les deux expositions seules puis ensemble, HDR/alpha finies, resize impair, NativeAA, optimisation d'aliasing activée/désactivée et parcours désactivé/réactivé de Babylon. npm run verify:packed-core:gpu exécute ces mêmes vérifications contre les exports de l'archive npm.

La machine locale dispose d'une RTX 5080. Les captures Q0, ratio 1.5, frames 8 et 32 après extraction correspondent pixel pour pixel à l'upstream propre. Cette comparaison porte sur les variantes baseline du harness ; elle ne remplace pas la matrice entière ni une comparaison exhaustive de la production.

Un relevé intercalé cross-build a exécuté les ratios 1, 1.5, 2 et 3, quatre blocs ABBA, 240 frames de chauffe et 600 échantillons par leg. Il compare les legs sans profiling du probe upstream (temps total et CPU). Aucun écart de temps total n'a dépassé le bruit observé ; ce relevé local ne remplace pas l'acceptation par timings GPU et sur RX 580. Les vues GPU des adaptateurs sont mises en cache par identité de texture.

## Conditions restant ouvertes

- RX 580 : matériel absent localement.
- Benchmark d'acceptation complet sur les deux GPU avec protocole upstream, mesures intercalées, profiling désactivé et seuil défini par le bruit.
- Revue visuelle humaine exhaustive : convergence immobile, mouvement caméra/objets, transparence, HDR, NativeAA, tous les presets et tailles impaires.
- Perte réelle du device et restauration du moteur, résolution dynamique continue et effets hôtes supplémentaires entre guides et upscale. Les annulations et invalidations du cœur sont couvertes côté CPU ; cela ne remplace pas ces parcours réels.

Les rapports locaux sont écrits sous bench/results/windows-local/, ignoré par git. Les validations non exécutées ne sont pas déclarées réussies.
