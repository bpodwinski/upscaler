# Attribution et provenance

Ce fork part de @pmndrs/upscaler v0.5.0, commit 5821d91. Le code upstream est attribué à Dennis Smolek et conserve sa licence MIT. Les shaders EASU/RCAS dérivent des travaux AMD FidelityFX Super Resolution ; le pipeline temporel suit l'architecture FSR 2/3. Les mentions AMD et les conditions MIT figurent dans LICENSE et restent incluses dans l'archive npm.

Le fork @ruxelion/upscaler ajoute le cœur WebGPU indépendant des moteurs, les exports séparés, les variantes de profondeur/exposition/RCAS et l'adaptateur Babylon Frame Graph. Il n'est affilié ni à AMD ni aux mainteneurs upstream. La version 0.6.0-alpha.0 est un candidat local ; ce travail ne publie pas le paquet.
