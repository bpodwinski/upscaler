# Adaptateur Babylon 9.29.x

L'intégration initiale fournit le chemin temporel complet via FrameGraphUpscaleTask. Elle est testée avec @babylonjs/core@9.29.0. Les accès internes nécessaires sont regroupés dans src/babylon/compatibility.ts et protégés par une vérification de version et de disponibilité du moteur WebGPU.

Construire la tâche avec un nom, le FrameGraph et des options contenant configuration, callback frame et réglages facultatifs. Assigner les handles colorTexture, depthTexture et velocityTexture, plus les éventuels reactiveTexture, reactiveOpaqueColorTexture, exposureTexture et preExposureTexture. Ajouter la tâche au graphe avant le consommateur de outputTexture. Attendre graph.buildAsync() avant la première exécution.

Les entrées doivent être rendues sous le même jitter que celui publié par upscale.jitter. beginFrame(camera) sauvegarde la projection existante, y compose le jitter et la fige. endFrame() restaure aussi son état de gel initial. Encadrer le rendu des entrées et l'exécution du graphe dans un try/finally ; en cas d'abandon, demander resetHistory(). unjitteredProjectionMatrix fournit la projection pour le calcul des mouvements.

L'hôte conserve la responsabilité de rendre la scène, d'écrire les mouvements, de linéariser la profondeur et de produire l'exposition. Les tâches en amont s'exécutent avant l'upscaler. [L'exemple complet](../examples/18-babylon-framegraph/main.ts) montre ces contrats avec une scène analytique HDR, sans masquer leur production derrière un pipeline de scène.

La tâche alloue toutes ses textures via le texture manager. Chaque historique a un seul handle ; getTextureFromHandle(handle, false/true) résout sa lecture/écriture. Aucune permutation supplémentaire n'est effectuée. Le traitement est enregistré dans une passe de rendu, car l'analyse des durées de vie de cette version collecte les dépendances de ces passes. Toutes les entrées et toutes les textures de travail figurent dans ses dépendances, y compris les historiques et textures factices.

Avant les passes compute, le pont ferme la passe de rendu active et récupère l'encodeur du moteur. L'adaptateur ne crée pas de second encodeur et ne soumet pas sur la queue. Le moteur conserve la fin de frame et la soumission.

Une tâche non préparée n'est pas prête à être exécutée ; attendre prepare(), graph.buildAsync() ou whenReadyAsync(). Les pipelines facultatives de debug et shading sont préparées aussi pour permettre les réglages retournés par le callback de frame. disabled = true produit une sortie bilinéaire définie dans le même handle et invalide l'historique temporel. La réactivation force un reset.

Après resize ou changement de variante, appeler configure(), attendre prepare(), puis reconstruire le Frame Graph avec buildAsync(). Les anciens handles intermédiaires appartiennent au texture manager et sont libérés par la reconstruction. Si des textures hôtes sont remplacées, reconstruire leurs dépendances et demander un reset. Après un encodeur abandonné, demander également un reset.

Le namespace avancé babylonWebGPU expose le pont protégé pour les tâches hôtes qui encodent leurs propres compute, comme le générateur analytique de l'exemple. Sa compatibilité reste limitée à la série 9.29.x.

La future migration Exokosm devra confirmer : unité et fond de profondeur, signe/espace du mouvement, projections sans jitter, reactive mask, distinction des deux expositions, dimensions dynamiques, position des tâches et présentation HDR. Ce fork ne modifie pas Exokosm.
