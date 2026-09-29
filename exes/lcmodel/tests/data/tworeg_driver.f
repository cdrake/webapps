C  Driver for tests/tworeg_vs_gfortran.rs. Build with conc_prior ...
C  parse_sum and NEXTRE, INFLEC, ILEN cut from LCModel.f (lines 7629-8045,
C  8069-8189, 12648-12656), lcmodel.inc and an ERRMES that prints and STOPs
C  on fatal levels:  gfortran -std=legacy -O2 tworeg_driver.f sub.f
      PROGRAM TWODRV
      INCLUDE 'lcmodel.inc'
      DOUBLE PRECISION P(40), G(0:44), DY(90), DZ(90), W
      INTEGER NEXTRE, INFLEC, NS(7), IM(7), ISEED
      REAL TH(7), FR
      CHARACTER*40 STR(9), CHR
      CHARACTER*4 SEP(9)
      INTEGER LSEP(9), ITYP(9), IATE(9), IST(9)
      DATA NS /2, 4, 6, 10, 20, 32, 40/
      DATA IM /0, 1, 0, 2, 0, 1, 0/
      DATA TH /.05, .1, .02, .05, .2, .01, .05/
      ISEED = 12345
      DO 100 IC = 1, 7
         N = NS(IC)
         W = 0.5D0 + 0.1D0 * IC
         DO 110 J = 1, N
            ISEED = MOD(ISEED * 1103 + 12849, 65536)
            P(J) = (DBLE(ISEED) / 65536.D0 - 0.3D0) * 0.4D0
            IF (MOD(J, 3) .EQ. 0) P(J) = -P(J) * 0.5D0
 110     CONTINUE
         DO 120 K = 0, N + 4
            G(K) = EXP(-(DBLE(K) / W)**2)
 120     CONTINUE
         DO 130 K = 1, 90
            DY(K) = 0.D0
            DZ(K) = 0.D0
 130     CONTINUE
         WRITE (*, '(A,I3,1X,Z8.8,I3)') 'LS', N, TH(IC), IM(IC)
         WRITE (*, '(A,100(1X,Z16.16))') 'P', (P(J), J = 1, N)
         WRITE (*, '(A,100(1X,Z16.16))') 'G', (G(K), K = 0, N + 4)
         I1 = NEXTRE(P, N, DY, G, TH(IC), IM(IC))
         I2 = INFLEC(P, N, DZ, G, TH(IC), IM(IC))
         WRITE (*, '(A,2I4)') 'R', I1, I2
         WRITE (*, '(A,100(1X,Z16.16))') 'DN', (DY(K), K = 1, 2*N+6)
         WRITE (*, '(A,100(1X,Z16.16))') 'DI', (DZ(K), K = 1, 2*N+10)
 100  CONTINUE
C     GET_FIELD cases
      STR(1) = 'NAAG/NAA = 0.15 +- 0.15'
      STR(2) = '  = 1'
      STR(3) = 'x =  abc +- 1'
      STR(4) = 'x = 1.2.3 +- 1'
      STR(5) = 'x = 0.123456789012 +- 1'
      STR(6) = 'x = 1 +- 2 +WT= GPC+PCh'
      STR(7) = 'x = 1 +- 2 +WT= GPC+PCh'
      STR(8) = 'x = 3E-2+-1'
      STR(9) = 'x = 1 +- 2   '
      SEP(1) = '='
      SEP(2) = '='
      SEP(3) = '+-'
      SEP(4) = '+-'
      SEP(5) = '+-'
      SEP(6) = '+WT='
      SEP(7) = ' '
      SEP(8) = '+-'
      SEP(9) = '+WT='
      DATA LSEP /1, 1, 2, 2, 2, 4, 0, 2, 4/
      DATA ITYP /1, 1, 2, 2, 2, 2, 1, 2, 2/
      DATA IATE /0, 0, 0, 0, 0, 1, 2, 0, 1/
      DATA IST /1, 1, 4, 4, 4, 9, 16, 4, 9/
      DO 200 IC = 1, 9
         CHR = '#'
         FR = -7.
         ISTART = IST(IC)
         CALL GET_FIELD (SEP(IC), LSEP(IC), ITYP(IC), IATE(IC), CHR,
     1        FR, ISTART, ILEN(STR(IC)), STR(IC))
         WRITE (*, '(A,I3,I4,1X,Z8.8,1X,A)') 'GF', IC, ISTART, FR,
     1        CHR(1:ILEN(CHR))
 200  CONTINUE
C     CONC_PRIOR
      LPRINT = 0
      IPDUMP = 0
      NMETAB = 7
      NACOMB(1) = 'NAA'
      NACOMB(2) = 'NAAG'
      NACOMB(3) = 'Cr'
      NACOMB(4) = 'PCr'
      NACOMB(5) = 'GPC'
      NACOMB(6) = 'PCh'
      NACOMB(7) = 'Ins'
      SOLBES(1,1) = 1.3D0
      SOLBES(2,1) = 0.2D0
      SOLBES(3,1) = 0.7D0
      SOLBES(4,1) = 0.45D0
      SOLBES(5,1) = 0.21D0
      SOLBES(6,1) = 0.D0
      SOLBES(7,1) = 0.9D0
      FCSUM = 0.01
      NNORAT = 1
      NORATO(1) = 'Ins'
      NRATIO = 9
      CHRATO(1) = 'NAAG/NAA = 0.15 +- 0.15'
      CHRATO(2) = 'PCr/Cr+PCr = 0.5 +- 0.1 +WT= GPC'
      CHRATO(3) = 'GPC/totCho = 0.6 +- 0.2'
      CHRATO(4) = 'PCh/Big3 = 0.1 +- 0.05'
      CHRATO(5) = 'Cr/P* = 0.3 +- 0.1'
      CHRATO(6) = 'Glu/Cr = 1 +- 1'
      CHRATO(7) = 'NAA/Lac = 1 +- 1'
      CHRATO(8) = 'Ins/Cr = 1 +- .5'
      CHRATO(9) = 'NAA/PCh = 2 +- 1'
      DO 300 J = 1, NRATIO
         CHRATW(J) = ' '
         CHRATI(J) = ' '
 300  CONTINUE
      CALL CONC_PRIOR ()
      WRITE (*, '(A,I4)') 'NU', NRATIO_USED
      DO 310 J = 1, NRATIO
         WRITE (*, '(A,I3,1X,A,1X,A)') 'CI', J,
     1        CHRATI(J)(1:ILEN(CHRATI(J))), CHRATW(J)(1:ILEN(CHRATW(J)))
 310  CONTINUE
      DO 320 J = 1, NRATIO_USED
         WRITE (*, '(A,2I4,3(1X,Z8.8),1X,A)') 'CU', J, LMETAB_PRIOR(J),
     1        SQRTWT_RATIO_USED(J), EXRATI(J), SDRATI(J),
     2        CHRATO(J)(1:ILEN(CHRATO(J)))
         WRITE (*, '(A,100(1X,Z8.8))') 'CP', (CPRIOR(J,K), K=1,NMETAB)
 320  CONTINUE
      LPRINT = 6
      IPDUMP = 3
      CALL CONC_PRIOR ()
      IPDUMP = 0
      CALL CONC_PRIOR ()
      END
